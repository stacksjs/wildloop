// GET /api/auth/google/callback — where Google sends the browser back.
//
// Verifies the state, exchanges the code, decides what account this is, and
// hands the session over.
//
// The hand-off deserves a word. This app authenticates with a bearer token the
// browser keeps in storage, and a redirect cannot put one there. Returning it
// in the URL — query or fragment — writes a live credential into browser
// history and, for a query, into every log between here and there. So the
// token goes into an httpOnly cookie that lives for a minute, and the page we
// land on trades it for the real session through `GoogleSessionAction`. The
// cookie cannot be read by script, and it is spent the first time it is used.
//
// The id token is read without verifying its signature, which is correct here
// and nowhere else: it arrives in the body of a server-to-server response from
// Google's token endpoint over TLS, so the channel is the proof. A token that
// reached us any other way would have to be verified.

import { Auth, resolveBrowserSessionPolicy } from '@stacksjs/auth'
import { config } from '@stacksjs/config'
import { db } from '@stacksjs/orm'
import { decideLink, profileFromClaims, stateIsAcceptable } from '../../Support/socialIdentity'
import {
  clearCookieHeader,
  cookieValue,
  googleRedirectUri,
  HANDOFF_COOKIE,
  handoffCookieHeader,
  STATE_COOKIE,
} from '../../Support/socialRequest'

/** Back to the sign-in page, saying what went wrong in a way it can show. */
function backToLogin(reason: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: `/login?error=${encodeURIComponent(reason)}`, 'Cache-Control': 'no-store' })
  for (const cookie of cookies)
    headers.append('Set-Cookie', cookie)
  return new Response(null, { status: 302, headers })
}

export default new Action({
  name: 'Google Callback',
  description: 'Complete a sign-in with Google',
  method: 'GET',

  async handle(request: any) {
    const google = config.auth?.social?.google
    if (!google?.clientId || !google?.clientSecret)
      return backToLogin('google-unavailable')

    const cookieHeader = request.headers?.get?.('cookie') ?? request.header?.('cookie') ?? null
    const issued = cookieValue(cookieHeader, STATE_COOKIE)
    const spent = clearCookieHeader(STATE_COOKIE)

    // Google reports a refusal here rather than by not arriving: somebody who
    // pressed Cancel comes back with `error=access_denied` and no code.
    if (request.get('error'))
      return backToLogin('google-cancelled', [spent])

    const returnedState = String(request.get('state') ?? '')
    const code = String(request.get('code') ?? '')
    if (!code)
      return backToLogin('google-failed', [spent])

    // The cookie carries when it was issued, so an abandoned sign-in stops
    // being usable on its own rather than only when the browser drops it.
    const [issuedValue, issuedAt] = (issued ?? '').split('|')
    const acceptable = stateIsAcceptable(
      issuedValue ? { value: issuedValue, createdAt: Number(issuedAt) || 0 } : null,
      returnedState,
      Date.now(),
    )
    if (!acceptable)
      return backToLogin('google-expired', [spent])

    let claims: Record<string, unknown>
    try {
      const exchanged = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code,
          client_id: google.clientId,
          client_secret: google.clientSecret,
          redirect_uri: googleRedirectUri(request),
          grant_type: 'authorization_code',
        }),
      })
      if (!exchanged.ok) {
        console.error('[auth] google token exchange failed', exchanged.status, await exchanged.text().catch(() => ''))
        return backToLogin('google-failed', [spent])
      }
      const body = await exchanged.json() as { id_token?: string }
      const payload = String(body.id_token ?? '').split('.')[1] ?? ''
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    }
    catch (error) {
      console.error('[auth] google token exchange threw', error)
      return backToLogin('google-failed', [spent])
    }

    const profile = profileFromClaims(claims)
    if (!profile)
      return backToLogin('google-failed', [spent])

    const identity = (await db.sql`
      SELECT user_id FROM user_identities WHERE provider = 'google' AND provider_user_id = ${profile.sub}
    `.execute() as any[])[0]
    const existing = profile.email
      ? (await db.sql`SELECT id, email FROM users WHERE lower(email) = ${profile.email}`.execute() as any[])[0]
      : null

    const decision = decideLink(
      profile,
      identity ? Number(identity.user_id) : null,
      existing ? { id: Number(existing.id), email: String(existing.email) } : null,
    )
    if (decision.action === 'refuse')
      return backToLogin(decision.reason === 'unverified-email' ? 'google-unverified' : 'google-failed', [spent])

    let userId = 0
    const now = new Date().toISOString()
    if (decision.action === 'create') {
      /*
       * An account nobody has a password for.
       *
       * `users.password` is NOT NULL in every database, generated from the
       * model's own validation rule, and SQLite cannot relax a column without
       * rebuilding the table — which is not a thing to do to a live users
       * table for tidiness. So the column gets 32 random bytes, hashed, with
       * the plaintext discarded unread. Nobody can sign in with a password
       * because there is no password to type, and "forgot password" still
       * works if this person later wants one.
       */
      const { makeHash } = await import('@stacksjs/security')
      const unguessable = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
      const created = (await db.sql`
        INSERT INTO users (name, email, password, created_at, updated_at)
        VALUES (${decision.name}, ${decision.email}, ${await makeHash(unguessable, { algorithm: 'bcrypt' })}, ${now}, ${now})
        RETURNING id
      `.execute() as any[])[0]
      userId = Number(created?.id ?? 0)
    }
    else {
      userId = decision.userId
    }

    if (!userId)
      return backToLogin('google-failed', [spent])

    // Remembered on purpose: somebody who signs in with a provider did not
    // choose a session length, and the provider is the thing they will use
    // again. This matches the "remember me" branch rather than the 12-hour one.
    const policy = resolveBrowserSessionPolicy(true)
    const session = await Auth.loginUsingId(userId, {
      expiresInMinutes: policy.expiresInMinutes,
      withRefreshToken: policy.withRefreshToken,
    }).catch((error: unknown) => {
      console.error('[auth] could not open a session for a google sign-in', error)
      return null
    })
    if (!session?.token)
      return backToLogin('google-failed', [spent])

    // Written after the session, so a failure above leaves no identity row
    // claiming a Google account that never signed in.
    if (decision.action !== 'sign-in') {
      await db.sql`
        INSERT INTO user_identities (user_id, provider, provider_user_id, email, created_at, updated_at)
        VALUES (${userId}, 'google', ${profile.sub}, ${profile.email || null}, ${now}, ${now})
      `.execute().catch((error: unknown) => console.error('[auth] could not record the google identity', error))
    }

    const headers = new Headers({ Location: '/login?google=1', 'Cache-Control': 'no-store' })
    headers.append('Set-Cookie', spent)
    headers.append('Set-Cookie', handoffCookieHeader(HANDOFF_COOKIE, session.token))
    return new Response(null, { status: 302, headers })
  },
})

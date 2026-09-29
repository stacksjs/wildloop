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
import { log } from '@stacksjs/logging'
import { decideLink, profileFromClaims, stateIsAcceptable } from '../../Support/socialIdentity'
import {
  clearCookieHeader,
  cookieValue,
  googleRedirectUri,
  HANDOFF_COOKIE,
  handoffCookieHeader,
  STATE_COOKIE,
} from '../../Support/socialRequest'

/**
 * Back to the page this started from, saying what went wrong in a way it can
 * show.
 *
 * The page matters: somebody who pressed the button on the sign-up page is
 * told "we could not create an account", not "we could not sign you in", and
 * each page carries its own wording for the same reason.
 */
function backTo(page: '/login' | '/register', reason: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: `${page}?error=${encodeURIComponent(reason)}`, 'Cache-Control': 'no-store' })
  for (const cookie of cookies)
    headers.append('Set-Cookie', cookie)
  return new Response(null, { status: 302, headers })
}

/**
 * Record the Google identity, and answer whether it is on record afterwards.
 *
 * A unique-index clash is the one failure that is not one: the row is already
 * there, from a retry or from two tabs racing. Re-reading tells that apart from
 * a real failure without depending on a particular driver's spelling of
 * "insert or ignore", or on matching its error codes — this app runs on SQLite
 * in production and is configured for MySQL and Postgres as well.
 *
 * A row claiming this Google account for somebody else is not a clash to
 * forgive. It should be impossible, since the lookup above found nothing, but
 * if it ever happens the honest answer is to refuse rather than hand over a
 * session tied to an identity that belongs to another account.
 */
async function identityIsOnRecord(
  userId: number,
  profile: { sub: string, email: string },
  now: string,
): Promise<boolean> {
  try {
    await db.sql`
      INSERT INTO user_identities (user_id, provider, provider_user_id, email, created_at, updated_at)
      VALUES (${userId}, 'google', ${profile.sub}, ${profile.email || null}, ${now}, ${now})
    `.execute()
    return true
  }
  catch (error) {
    const existing = (await db.sql`
      SELECT user_id FROM user_identities WHERE provider = 'google' AND provider_user_id = ${profile.sub}
    `.execute().catch(() => []) as any[])[0]

    if (existing && Number(existing.user_id) === userId)
      return true

    log.error('[auth] could not record a Google identity', error)
    return false
  }
}

export default new Action({
  name: 'Google Callback',
  description: 'Complete a sign-in with Google',
  method: 'GET',

  async handle(request: any) {
    const cookieHeader = request.headers?.get?.('cookie') ?? request.header?.('cookie') ?? null
    const issued = cookieValue(cookieHeader, STATE_COOKIE)
    const spent = clearCookieHeader(STATE_COOKIE)
    const [issuedValue, issuedAt, issuedFrom] = (issued ?? '').split('|')
    // Read before anything can fail, because every failure below has to know
    // which page to return to. Only ever one of two, whatever the cookie says.
    const back: '/login' | '/register' = issuedFrom === 'register' ? '/register' : '/login'

    const google = config.auth?.social?.google
    if (!google?.clientId || !google?.clientSecret)
      return backTo(back, 'google-unavailable', [spent])

    // Google reports a refusal here rather than by not arriving: somebody who
    // pressed Cancel comes back with `error=access_denied` and no code.
    if (request.get('error'))
      return backTo(back, 'google-cancelled', [spent])

    const returnedState = String(request.get('state') ?? '')
    const code = String(request.get('code') ?? '')
    if (!code)
      return backTo(back, 'google-failed', [spent])

    // The cookie carries when it was issued, so an abandoned sign-in stops
    // being usable on its own rather than only when the browser drops it.
    const acceptable = stateIsAcceptable(
      issuedValue ? { value: issuedValue, createdAt: Number(issuedAt) || 0 } : null,
      returnedState,
      Date.now(),
    )
    if (!acceptable)
      return backTo(back, 'google-expired', [spent])

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
        return backTo(back, 'google-failed', [spent])
      }
      const body = await exchanged.json() as { id_token?: string }
      const payload = String(body.id_token ?? '').split('.')[1] ?? ''
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    }
    catch (error) {
      console.error('[auth] google token exchange threw', error)
      return backTo(back, 'google-failed', [spent])
    }

    const profile = profileFromClaims(claims)
    if (!profile)
      return backTo(back, 'google-failed', [spent])

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
      return backTo(back, decision.reason === 'unverified-email' ? 'google-unverified' : 'google-failed', [spent])

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
      return backTo(back, 'google-failed', [spent])

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
      return backTo(back, 'google-failed', [spent])

    // Written after the session, so a failure above leaves no identity row
    // claiming a Google account that never signed in.
    //
    // A sign-in whose identity was not recorded looks exactly like one that
    // worked, and goes wrong later: without the row, every future sign-in
    // falls back to matching on the address, so the day somebody's Wildloop
    // address differs from their Google one they quietly get a second,
    // empty account instead of their own. That is worth refusing over —
    // anyone who reached here through an existing account still has their
    // password, and anyone new can try again.
    if (decision.action !== 'sign-in' && !(await identityIsOnRecord(userId, profile, now))) {
      log.error('[auth] refused a Google sign-in whose identity could not be recorded', { userId, provider: 'google' })
      return backTo(back, 'google-failed', [spent])
    }

    const headers = new Headers({ Location: `${back}?google=1`, 'Cache-Control': 'no-store' })
    headers.append('Set-Cookie', spent)
    headers.append('Set-Cookie', handoffCookieHeader(HANDOFF_COOKIE, session.token))
    return new Response(null, { status: 302, headers })
  },
})

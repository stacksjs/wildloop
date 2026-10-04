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

import { config } from '@stacksjs/config'
import { finishSocialSignIn } from '../../Support/socialAccount'
import { profileFromClaims, stateIsAcceptable } from '../../Support/socialIdentity'
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

    // Who this is, and the session for them: the same steps Apple takes, in
    // socialAccount.ts, so the part that can cost somebody their account
    // exists once.
    const outcome = await finishSocialSignIn('google', profile)
    if (!outcome.ok)
      return backTo(back, outcome.reason === 'unverified' ? 'google-unverified' : 'google-failed', [spent])

    const headers = new Headers({ Location: `${back}?google=1`, 'Cache-Control': 'no-store' })
    headers.append('Set-Cookie', spent)
    headers.append('Set-Cookie', handoffCookieHeader(HANDOFF_COOKIE, outcome.token))
    return new Response(null, { status: 302, headers })
  },
})

// POST /api/auth/apple/callback — where Apple sends the browser back.
//
// A POST, unlike Google's: Apple returns the code, the state and (the first
// time only) the person's name in a form it submits from appleid.apple.com,
// because it will not send a name or an address any other way.
//
// Everything after the exchange is Google's path exactly — the same
// `decideLink`, the same account creation, the same one-minute hand-off
// cookie traded for the session by the landing page (see
// GoogleCallbackAction for why the token never travels in a URL).
//
// The id token is read without verifying its signature, for the reason
// Google's is: it arrives in the body of a server-to-server response from
// Apple's token endpoint over TLS, so the channel is the proof. Its issuer and
// audience are checked regardless, in `appleProfileFromClaims`.

import { config } from '@stacksjs/config'
import {
  APPLE_ISSUER,
  appleClientSecret,
  appleDisplayName,
  appleNameFromUser,
  appleProfileFromClaims,
} from '../../Support/appleSignIn'
import { finishSocialSignIn } from '../../Support/socialAccount'
import { stateIsAcceptable } from '../../Support/socialIdentity'
import {
  APPLE_HANDOFF_COOKIE,
  APPLE_STATE_COOKIE,
  appleRedirectUri,
  clearCrossSiteCookieHeader,
  cookieValue,
  handoffCookieHeader,
} from '../../Support/socialRequest'

/** Back to the page this started from, with a reason it knows how to say. */
function backTo(page: '/login' | '/register', reason: string, cookies: string[] = []): Response {
  // 303, not 302: this answers a POST, and 303 is the status that says
  // "now GET this" rather than leaving the method to the browser's judgement.
  const headers = new Headers({ Location: `${page}?error=${encodeURIComponent(reason)}`, 'Cache-Control': 'no-store' })
  for (const cookie of cookies)
    headers.append('Set-Cookie', cookie)
  return new Response(null, { status: 303, headers })
}

export default new Action({
  name: 'Apple Callback',
  description: 'Complete a sign-in with Apple',
  method: 'POST',

  // Apple posts this form from its own origin, so it cannot carry our CSRF
  // token. The state cookie is what a CSRF token would be here: a callback
  // carrying a state this server did not issue in the last ten minutes is
  // refused before anything is exchanged.
  skipCsrf: true,

  async handle(request: any) {
    const cookieHeader = request.headers?.get?.('cookie') ?? request.header?.('cookie') ?? null
    const issued = cookieValue(cookieHeader, APPLE_STATE_COOKIE)
    const spent = clearCrossSiteCookieHeader(APPLE_STATE_COOKIE)
    const [issuedValue, issuedAt, issuedFrom] = (issued ?? '').split('|')
    const back: '/login' | '/register' = issuedFrom === 'register' ? '/register' : '/login'

    const apple = config.auth?.social?.apple
    if (!apple?.configured)
      return backTo(back, 'apple-unavailable', [spent])

    // Cancelling on Apple's page comes back as `error=user_cancelled_authorize`
    // with no code.
    if (request.get('error'))
      return backTo(back, 'apple-cancelled', [spent])

    const returnedState = String(request.get('state') ?? '')
    const code = String(request.get('code') ?? '')
    if (!code)
      return backTo(back, 'apple-failed', [spent])

    const acceptable = stateIsAcceptable(
      issuedValue ? { value: issuedValue, createdAt: Number(issuedAt) || 0 } : null,
      returnedState,
      Date.now(),
    )
    if (!acceptable)
      return backTo(back, 'apple-expired', [spent])

    let claims: Record<string, unknown>
    try {
      // Minted here rather than read from config: Apple's "secret" is a JWT
      // signed with our key and valid for minutes, so it is made fresh for the
      // one exchange that uses it. A key that will not import fails here,
      // which is a configuration problem, and the log says so.
      const clientSecret = await appleClientSecret({
        clientId: apple.clientId,
        teamId: apple.teamId,
        keyId: apple.keyId,
        privateKey: apple.privateKey,
      })

      const exchanged = await fetch(`${APPLE_ISSUER}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: apple.clientId,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: appleRedirectUri(request),
        }),
      })
      if (!exchanged.ok) {
        console.error('[auth] apple token exchange failed', exchanged.status, await exchanged.text().catch(() => ''))
        return backTo(back, 'apple-failed', [spent])
      }
      const body = await exchanged.json() as { id_token?: string } | null
      const payload = String(body?.id_token ?? '').split('.')[1] ?? ''
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    }
    catch (error) {
      console.error('[auth] apple token exchange threw', error)
      return backTo(back, 'apple-failed', [spent])
    }

    const profile = appleProfileFromClaims(claims ?? {}, apple.clientId)
    if (!profile)
      return backTo(back, 'apple-failed', [spent])

    // The name, if Apple sent it, which it does only the first time this
    // Apple ID authorizes Wildloop. Used for a new account and nothing else:
    // an existing account keeps the name its owner gave it.
    profile.name = appleDisplayName(profile, appleNameFromUser(request.get('user')))

    const outcome = await finishSocialSignIn('apple', profile)
    if (!outcome.ok)
      return backTo(back, outcome.reason === 'unverified' ? 'apple-unverified' : 'apple-failed', [spent])

    const headers = new Headers({ Location: `${back}?apple=1`, 'Cache-Control': 'no-store' })
    headers.append('Set-Cookie', spent)
    headers.append('Set-Cookie', handoffCookieHeader(APPLE_HANDOFF_COOKIE, outcome.token))
    return new Response(null, { status: 303, headers })
  },
})

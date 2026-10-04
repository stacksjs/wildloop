// GET /api/auth/apple/redirect — start a sign-in with Apple.
//
// The same shape as Google's: a one-shot state in a short-lived httpOnly
// cookie, and a redirect to Apple. The cookie differs in one attribute, and it
// is the attribute that decides whether this works at all — Apple comes back
// with a cross-site form POST, which a `SameSite=Lax` cookie is withheld from.
// See `crossSiteStateCookieHeader`.

import { config } from '@stacksjs/config'
import { appleAuthorizeUrl } from '../../Support/appleSignIn'
import { APPLE_STATE_COOKIE, appleRedirectUri, crossSiteStateCookieHeader } from '../../Support/socialRequest'

export default new Action({
  name: 'Apple Redirect',
  description: 'Send the browser to Apple to sign in',
  method: 'GET',

  async handle(request) {
    const apple = config.auth?.social?.apple
    if (!apple?.configured) {
      // The buttons are hidden in this state, so reaching here means a stale
      // page or a hand-typed URL. Nothing the visitor can do about it.
      return response.json({ success: false, error: 'Signing in with Apple is not available.' }, 503)
    }

    const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')
    // Matched against a fixed pair rather than echoed: it decides where the
    // browser is sent afterwards, and anything it could hold is an open
    // redirect.
    const origin = String(request.get('from') ?? '') === 'register' ? 'register' : 'login'

    return new Response(null, {
      status: 302,
      headers: {
        'Location': appleAuthorizeUrl({
          clientId: apple.clientId,
          redirectUri: appleRedirectUri(request),
          state,
        }),
        'Set-Cookie': crossSiteStateCookieHeader(APPLE_STATE_COOKIE, `${state}|${Date.now()}|${origin}`),
        'Cache-Control': 'no-store',
      },
    })
  },
})

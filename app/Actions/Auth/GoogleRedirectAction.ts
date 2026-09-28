// GET /api/auth/google/redirect — start a sign-in with Google.
//
// Issues a one-shot state, remembers it in a short-lived httpOnly cookie, and
// sends the browser to Google. The cookie is the only copy we keep: the
// callback compares what Google returns against it, so a request that did not
// begin here cannot finish here.

import { config } from '@stacksjs/config'
import { authorizeUrl } from '../../Support/socialIdentity'
import { googleRedirectUri, STATE_COOKIE, stateCookieHeader } from '../../Support/socialRequest'

export default new Action({
  name: 'Google Redirect',
  description: 'Send the browser to Google to sign in',
  method: 'GET',

  async handle(request) {
    const google = config.auth?.social?.google
    if (!google?.clientId || !google?.clientSecret) {
      // Not configured is not an error the visitor caused, and there is
      // nothing for them to do about it. The buttons are hidden in this state,
      // so reaching here means a stale page or a hand-typed URL.
      return response.json({ success: false, error: 'Signing in with Google is not available.' }, 503)
    }

    // 32 bytes of randomness, hex. Long enough that guessing is not a strategy,
    // and `stateIsAcceptable` refuses anything shorter than 16 characters.
    const state = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('')

    return new Response(null, {
      status: 302,
      headers: {
        'Location': authorizeUrl({
          clientId: google.clientId,
          redirectUri: googleRedirectUri(request),
          state,
        }),
        // The issue time rides along, so the callback can refuse an
        // abandoned sign-in itself rather than trusting the browser to have
        // dropped the cookie on time.
        'Set-Cookie': stateCookieHeader(STATE_COOKIE, `${state}|${Date.now()}`),
        // Nothing about this response is reusable: it carries a one-shot
        // ticket, and a cached copy would send the next person to Google with
        // a state their browser has no cookie for.
        'Cache-Control': 'no-store',
      },
    })
  },
})

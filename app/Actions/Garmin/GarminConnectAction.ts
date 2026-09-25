// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// Step one of connecting a watch: send the athlete to Garmin to approve.

import { Auth } from '@stacksjs/auth'

import { randomBytes } from 'node:crypto'
import process from 'node:process'
import garminConfig from '../../../config/garmin'
import { buildAuthorizeUrl, createPkcePair, isConfigured, sealOAuthState } from '../../Support/garminConnect'

/** Cookie carrying the in-flight attempt across the redirect to Garmin. */
export const OAUTH_COOKIE = 'garmin_oauth'

export default new Action({
  name: 'Garmin Connect',
  description: 'Start the Garmin authorization flow',
  method: 'GET',

  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Sign in to continue.' }, 401)

    if (!isConfigured(garminConfig)) {
      return response.json({
        success: false,
        error: 'Garmin syncing is not available yet. It turns on once Garmin approves this app for their Activity API.',
      }, 503)
    }

    const { verifier, challenge } = createPkcePair()
    const state = randomBytes(16).toString('base64url')

    // Signed with the app key so the athlete cannot edit the userId in their
    // own cookie and attach their watch to somebody else's account.
    const secret = process.env.APP_KEY || ''
    if (!secret) {
      // Failing loudly beats issuing an unsigned token that looks like it
      // protects something.
      return response.json({ success: false, error: 'Server is missing APP_KEY; cannot start a secure connection.' }, 500)
    }

    const sealed = sealOAuthState({ userId: user.id, state, verifier, issuedAt: Date.now() }, secret)

    const url = buildAuthorizeUrl({
      authorizeEndpoint: garminConfig.endpoints.authorize,
      clientId: garminConfig.clientId,
      redirectUri: garminConfig.redirectUri,
      state,
      challenge,
      scope: garminConfig.scope,
    })

    // HttpOnly so page scripts cannot read the verifier. SameSite=Lax rather
    // than Strict because the callback is a top-level navigation from
    // garmin.com, and Strict would withhold the cookie exactly then, leaving
    // every connection attempt unable to identify who started it.
    const cookie = [
      `${OAUTH_COOKIE}=${sealed}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=600',
      request.url?.startsWith('https://') ? 'Secure' : null,
    ].filter(Boolean).join('; ')

    // Returns the URL rather than redirecting to it. This route is behind
    // `auth`, and the session is a bearer token in localStorage, which a
    // top-level navigation cannot send - so the browser has to fetch this
    // with its token and then navigate itself. The cookie set here is stored
    // all the same, which is what the callback later reads.
    const json = response.json({ success: true, url })
    json.headers.append('Set-Cookie', cookie)
    return json
  },
})

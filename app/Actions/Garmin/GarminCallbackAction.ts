// No imports needed - everything is auto-imported!
//
// Step two: Garmin sends the athlete back with an authorization code, which we
// redeem for tokens and store against their account.
//
// This request arrives as a top-level navigation from garmin.com, so it
// carries no Authorization header. The signed cookie set in step one is what
// says who was connecting.

import process from 'node:process'
import garminConfig from '../../../config/garmin'
import { OAUTH_COOKIE, readOAuthCookie, garminSettingsRedirect as backToSettings, nativeGarminRedirect, NATIVE_GARMIN_STATE_PREFIX } from '../../Support/garminOAuth'
import { connectGarminAccount } from '../../Support/garminConnection'
import { isConfigured, openOAuthState } from '../../Support/garminConnect'

export default new Action({
  name: 'Garmin Callback',
  description: 'Exchange the Garmin authorization code for tokens and store the connection',
  method: 'GET',

  async handle(request) {
    const url = new URL(request.url)
    const nativeState=url.searchParams.get('state') ?? ''
    if(nativeState.startsWith(NATIVE_GARMIN_STATE_PREFIX))
      return nativeGarminRedirect(url.searchParams.get('code'),nativeState,url.searchParams.get('error') || (!isConfigured(garminConfig) ? 'unavailable' : null))
    if (!isConfigured(garminConfig)) return backToSettings('unavailable')
    // Garmin reports a refusal here rather than by status code. Someone who
    // pressed Cancel should land on a page that says so, not an error.
    if (url.searchParams.get('error'))
      return backToSettings('denied')

    const code = url.searchParams.get('code')
    const returnedState = url.searchParams.get('state')
    if (!code || !returnedState)
      return backToSettings('failed')

    const sealed = openOAuthState(readOAuthCookie(request, OAUTH_COOKIE), process.env.APP_KEY || '')
    if (!sealed)
      return backToSettings('expired')

    // The CSRF check the `state` parameter exists for: a code obtained in
    // someone else's browser cannot be planted into this athlete's session.
    if (sealed.state !== returnedState)
      return backToSettings('failed')

    try {
      await connectGarminAccount(garminConfig,sealed.userId,code,sealed.verifier)

      return backToSettings('connected')
    }
    catch {
      console.error('[garmin] callback exchange failed')
      return backToSettings('failed')
    }
  },
})

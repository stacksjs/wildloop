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
import { OAUTH_COOKIE } from './GarminConnectAction'
import { backfillWindow, createGarminClient, isConfigured, openOAuthState } from '../../Support/garminConnect'

/** Read one cookie off the request. */
function readCookie(request: any, name: string): string | undefined {
  const header: string = request?.headers?.get?.('cookie') || ''
  for (const part of header.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1)
      continue
    if (part.slice(0, separator).trim() === name)
      return part.slice(separator + 1).trim()
  }
  return undefined
}

/** Send the athlete back to settings with a result they can read. */
function backToSettings(outcome: string): Response {
  const redirect = response.redirect(`/settings?garmin=${outcome}`, 302)
  // The attempt is over either way; do not leave the verifier lying around.
  redirect.headers.append('Set-Cookie', `${OAUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  return redirect
}

export default new Action({
  name: 'Garmin Callback',
  description: 'Exchange the Garmin authorization code for tokens and store the connection',
  method: 'GET',

  async handle(request) {
    if (!isConfigured(garminConfig))
      return backToSettings('unavailable')

    const url = new URL(request.url)
    // Garmin reports a refusal here rather than by status code. Someone who
    // pressed Cancel should land on a page that says so, not an error.
    if (url.searchParams.get('error'))
      return backToSettings('denied')

    const code = url.searchParams.get('code')
    const returnedState = url.searchParams.get('state')
    if (!code || !returnedState)
      return backToSettings('failed')

    const sealed = openOAuthState(readCookie(request, OAUTH_COOKIE), process.env.APP_KEY || '')
    if (!sealed)
      return backToSettings('expired')

    // The CSRF check the `state` parameter exists for: a code obtained in
    // someone else's browser cannot be planted into this athlete's session.
    if (sealed.state !== returnedState)
      return backToSettings('failed')

    try {
      const client = createGarminClient(garminConfig)
      const tokens = await client.exchangeCode(code, sealed.verifier)
      const garminUserId = await client.getUserId(tokens.accessToken)

      const { db } = await import('@stacksjs/database')
      const expiresAt = tokens.expiresAt ?? null

      // Reconnecting replaces the previous row rather than accumulating them,
      // and the unique index on garmin_user_id stops one watch feeding two
      // accounts.
      await db.deleteFrom('garmin_connections').where('user_id', '=', sealed.userId).execute()
      await db.deleteFrom('garmin_connections').where('garmin_user_id', '=', garminUserId).execute()
      await db.insertInto('garmin_connections').values({
        user_id: sealed.userId,
        garmin_user_id: garminUserId,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken ?? null,
        expires_at: expiresAt,
        scope: tokens.scope ?? garminConfig.scope,
      }).execute()

      // Ask for recent history. Pushes only cover activities finished after
      // this moment, so without this the runs already on the watch never
      // arrive. Garmin replies 202 and delivers them through the webhook.
      // Best effort: the connection stands even if Garmin refuses, and new
      // activities still arrive on their own.
      try {
        const { start, end } = backfillWindow()
        await client.requestBackfill(tokens.accessToken, start, end)
      }
      catch (error) {
        console.error('[garmin] backfill request failed; only new activities will import', error)
      }

      return backToSettings('connected')
    }
    catch (error) {
      console.error('[garmin] callback failed', error)
      return backToSettings('failed')
    }
  },
})

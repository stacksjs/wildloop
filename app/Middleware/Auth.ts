import { Auth } from '@stacksjs/auth'
import { config } from '@stacksjs/config'
import { db } from '@stacksjs/database'
import { HttpError } from '@stacksjs/error-handling'
import { Middleware } from '@stacksjs/router'
import { bearerFrom, DAY_MS, slidExpiry, tokenTimestamp } from '../Support/sessionTokens'

/**
 * API authentication: a bearer token, and nothing else.
 *
 * The framework's default also signs a request in from its auth cookie or a
 * server session. Neither client uses them: the web app and the iOS app both
 * send `Authorization: Bearer`. A cookie is also the one credential a browser
 * attaches to a request another site made, so accepting it would only have
 * added a way in.
 *
 * Each authenticated request also slides the token's expiry forward (see
 * `slidExpiry`), so an active athlete is not signed out on day 30 in the
 * middle of uploading a run.
 */
export default new Middleware({
  name: 'Auth',
  priority: 1,
  async handle(request: any) {
    const token = bearerFrom(request)
    if (!token)
      throw new HttpError(401, 'Unauthorized. Send your token as Authorization: Bearer.')

    const user = await Auth.getUserFromToken(token)
    if (!user)
      throw new HttpError(401, 'Unauthorized. Invalid or expired token.')

    Auth.setUser(user)
    request._authenticatedUser = user
    const accessToken = await Auth.currentAccessToken()
    request._currentAccessToken = accessToken

    const lifetimeMs = Number(config.auth?.tokenExpiry) || 30 * DAY_MS
    const next = accessToken ? slidExpiry(accessToken.expiresAt, Date.now(), lifetimeMs) : null
    if (!next || !accessToken)
      return

    // Keeping the session alive must never cost the request it rides on.
    await db.updateTable('oauth_access_tokens')
      .set({ expires_at: tokenTimestamp(next) })
      .where('id', '=', accessToken.id)
      .execute()
      .catch((error: unknown) => console.error('[auth] could not extend token expiry', error))
  },
})

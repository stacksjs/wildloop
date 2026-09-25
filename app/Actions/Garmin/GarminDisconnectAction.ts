// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// Disconnecting has to be as easy as connecting, and it has to actually stop
// the data: telling Garmin to deregister is what ends the push notifications.
// Deleting only our row would leave Garmin sending activities for an athlete
// who believes they have unplugged.

import { Auth } from '@stacksjs/auth'

import garminConfig from '../../../config/garmin'
import { createGarminClient } from '../../Support/garminConnect'

export default new Action({
  name: 'Garmin Disconnect',
  description: 'Revoke the Garmin connection and stop receiving activities',
  method: 'POST',

  async handle() {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Sign in to continue.' }, 401)

    const { db } = await import('@stacksjs/database')

    const connection = await db
      .selectFrom('garmin_connections')
      .select(['access_token'])
      .where('user_id', '=', user.id)
      .executeTakeFirst()
      .catch(() => null)

    if (!connection)
      return response.json({ success: true, disconnected: true })

    // Best effort, and deliberately not fatal. If Garmin is unreachable we
    // still remove the connection here, because leaving someone connected
    // because a third party had an outage is the wrong way to fail. The
    // athlete can also revoke us from their own Garmin account settings.
    try {
      await createGarminClient(garminConfig).deregister(connection.access_token)
    }
    catch (error) {
      console.error('[garmin] deregistration call failed; removing the local connection anyway', error)
    }

    await db.deleteFrom('garmin_connections').where('user_id', '=', user.id).execute()

    // The import ledger stays. It is what stops previously imported activities
    // from arriving a second time if the athlete reconnects later.
    return response.json({ success: true, disconnected: true })
  },
})

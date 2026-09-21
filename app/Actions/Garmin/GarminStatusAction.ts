// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// What the settings screen needs to decide what to show: is the integration
// available at all, and is this athlete already connected.

import { Auth } from '@stacksjs/auth'

import garminConfig from '../../../config/garmin'
import { isConfigured } from './garmin'

export default new Action({
  name: 'Garmin Status',
  description: 'Whether Garmin syncing is available, and whether this account is connected',
  method: 'GET',

  async handle() {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Sign in to continue.' }, 401)

    const configured = isConfigured(garminConfig)

    // Distinguishing "not set up yet" from "not connected" is the difference
    // between a button that explains itself and one that fails on click.
    if (!configured)
      return response.json({ success: true, configured: false, connected: false })

    const { db } = await import('@stacksjs/database')
    const connection = await db
      .selectFrom('garmin_connections')
      .select(['garmin_user_id', 'created_at', 'last_sync_at'])
      .where('user_id', '=', user.id)
      .executeTakeFirst()
      .catch(() => null)

    // Note what is deliberately absent: no tokens. The client never needs
    // them, and anything sent to a browser is a secret with a wider blast
    // radius than it looks.
    return response.json({
      success: true,
      configured: true,
      connected: Boolean(connection),
      connectedAt: connection?.created_at ?? null,
      lastSyncAt: connection?.last_sync_at ?? null,
    })
  },
})

// Auth is imported explicitly, as in every admin action here: `Auth.user()` is
// not in the API bundle's auto-imports.
//
// POST /api/maintenance/reingest-region (admin) — ask the trail ingest worker
// to fetch one region again (#976).
//
//   { "region": "CO", "limit": 20 }   → 202 { queued, alreadyQueued, ... }
//
// This queues and returns. The worker (app/TrailIngestWorker.ts, its own
// systemd unit) claims the tiles from `trail_ingest_shards` like any other
// pending work, so the request never holds an Overpass fetch open — a region
// is hours of the worker's time and milliseconds of this one's.
//
// What keeps it from aiming the Overpass budget anywhere on a whim lives in
// app/Ingest/reingest.ts: only regions the catalog covers, at most
// REINGEST_MAX_TILES a request, nothing finished in the last day, and a tile
// already queued is not queued twice. The route adds a rate limit on top.

import { Auth } from '@stacksjs/auth'
import { REINGEST_MAX_TILES, reingestRegion } from '../../Ingest/reingest'
import { isAdminUser } from '../../Support/routeEfforts'

export default new Action({
  name: 'Reingest Region',
  description: 'Queue one region of the trail catalog to be ingested again',
  method: 'POST',

  async handle(request) {
    // `role:admin` on the route says the same. It is checked again here for
    // the reason RouteEffortReviewAction gives: that middleware once answered
    // 500 to admin and stranger alike, and this is the only check standing
    // between a stranger and the ingest budget.
    const caller = await Auth.user().catch(() => null)
    if (!caller)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!await isAdminUser(caller.id))
      return response.json({ success: false, error: 'Admin access required' }, 403)

    const region = String(request.get('region') ?? '').trim()
    const rawLimit = request.get('limit')
    const limit = rawLimit === undefined || rawLimit === null || rawLimit === '' ? undefined : Number(rawLimit)

    const fields: Record<string, string> = {}
    if (!region)
      fields.region = 'required: a region code the trail catalog covers, e.g. CO or DE-BY'
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > REINGEST_MAX_TILES))
      fields.limit = `must be a whole number from 1 to ${REINGEST_MAX_TILES}`
    if (Object.keys(fields).length)
      return response.json({ success: false, error: 'Validation failed', fields }, 422)

    try {
      const result = await reingestRegion(region, { limit })
      if (!result) {
        return response.json({
          success: false,
          error: 'Validation failed',
          fields: { region: `not a region the trail catalog covers: ${region.slice(0, 20)}` },
        }, 422)
      }

      // 202: accepted for processing, not processed. The worker reaches the
      // tiles on its own schedule, within one idle sleep when it is caught up.
      return response.json({ success: true, ...result }, 202)
    }
    catch (error) {
      console.error('[ingest] could not queue a region for re-ingestion', error)
      return response.json({ success: false, error: 'Could not queue the region' }, 500)
    }
  },
})

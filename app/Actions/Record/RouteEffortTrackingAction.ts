// GET /api/route-efforts/tracking - attempts that are out there right now.
//
// The board people refresh. It is deliberately public and session-free so a
// tracking link can be handed to a crew, a family, or a local paper without
// any of them holding a Wildloop account.
//
// An attempt appears here from the moment it is announced and drops off when
// it finishes, DNFs, or goes stale. Staleness matters: an athlete who forgets
// to close out their row would otherwise sit at the top of the board forever,
// and a board full of ghosts is one nobody trusts.

import RouteEffort from '../../Models/RouteEffort'

import { formatElapsed } from '../../../resources/functions/route-records'
import { shapeEfforts } from './record-support'

/**
 * How long an announced attempt stays on the board without being closed out.
 *
 * Long enough for the longest routes in the catalog - a 2,600-mile thru-run
 * is months, but nobody watches one minute-by-minute, and a row that has not
 * moved in three weeks has stopped being news either way.
 */
const STALE_AFTER_DAYS = 21

export default new Action({
  name: 'Route Effort Tracking',
  description: 'Record attempts currently in progress',
  method: 'GET',

  async handle(request) {
    try {
      const rows = (await RouteEffort.where('status', '=', 'in_progress').get()) ?? []
      const cutoff = Date.now() - STALE_AFTER_DAYS * 86_400_000
      const live = rows.filter((row: any) => {
        const started = Date.parse(row.started_at)
        return Number.isFinite(started) && started >= cutoff
      })

      const shaped = await shapeEfforts(live)
      const now = Date.now()
      const tracking = shaped
        .map((effort) => {
          const elapsed = Math.max(0, Math.round((now - Date.parse(effort.startedAt)) / 1000))
          return {
            ...effort,
            // The clock a spectator reads: time on the course so far, which is
            // the only number an unfinished attempt actually has.
            elapsedSoFar: elapsed,
            elapsedSoFarLabel: formatElapsed(elapsed),
          }
        })
        // Most recently started first: a start today is the news, a start
        // nine days ago is a thru-run people already know about.
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt) || b.id - a.id)

      const { items, meta } = paginate(tracking, readPageParams(request, { defaultLimit: 30, maxLimit: 100 }))
      return response.json({ success: true, tracking: items, meta, staleAfterDays: STALE_AFTER_DAYS })
    }
    catch (error) {
      console.error('[records] tracking failed:', error)
      return response.json({ success: false, error: 'Failed to fetch live attempts' }, 500)
    }
  },
})

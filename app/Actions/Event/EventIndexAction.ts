// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. `db` is imported the way
// the other raw-SQL actions import it; everything else here is auto-imported
// as usual.
//
// GET /api/events - the events directory. Public read.
//
// `?status=live|scheduled|finished`, `?type=backyard|race|group_run|time_trial`,
// `?club=<id>` and `?q=<text>` (name or location) narrow it. Ordering puts
// live events first, then the next ones to start, then the most recently
// finished: what somebody opening this page wants is something to watch right
// now, and failing that, something to enter.
//
// Each row carries `lat`/`lng` (null when unknown) so the page can sort by
// distance from the visitor and filter by radius. That happens in the browser:
// the visitor's position never has to be sent here to get a local list.

import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { eventDirectory } from '../../Support/eventDirectory'
import { textQuery } from '../../Support/textQuery'

export default new Action({
  name: 'Event Index',
  description: 'List events with entrant counts and live progress',
  method: 'GET',

  async handle(request) {
    try {
      const sessionUser = (await Auth.user().catch(() => null))?.id ?? null
      const run = async (sql: string) => (await db.sql`${db.unsafe(sql)}`.execute() as any[]) ?? []

      // A club event is only listed to that club's members; a private one only
      // to its host and entrants. Visibility is decided in the query (see
      // eventDirectory), so an unlisted event never reaches the browser at
      // all, and entrants are counted only for the page being returned.
      const { events, meta } = await eventDirectory(run, {
        viewer: sessionUser,
        type: request.get<string>('type'),
        status: request.get<string>('status'),
        club: positiveInt(request.get('club')),
        query: textQuery(request.get('q')),
      }, readPageParams(request, { defaultLimit: 60, maxLimit: 200 }))
      return response.json({ success: true, events, meta })
    }
    catch (error) {
      console.error('[events] index failed:', error)
      return response.json({ success: false, error: 'Failed to fetch events' }, 500)
    }
  },
})

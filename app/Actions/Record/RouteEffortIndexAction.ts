// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// GET /api/route-efforts - the latest-records feed, and the general filter.
//
// Defaults to verified records, newest finish first, because that is the
// front page of a records board: what has just been set. Everything else -
// one athlete's history, one route, one status - is the same query with a
// filter applied.

import { Auth } from '@stacksjs/auth'
import RouteEffort from '../../Models/RouteEffort'
import { paginate, readPageParams } from '../../../resources/functions/pagination'
import { positiveInt } from '../../../resources/functions/validate'

import { asCategory, asDirection, asStatus, asStyle, isAdminUser, PUBLIC_STATUSES, shapeEfforts } from '../../Support/routeEfforts'

export default new Action({
  name: 'Route Effort Index',
  description: 'Latest records and filtered record attempts',
  method: 'GET',

  async handle(request) {
    const viewerId = (await Auth.user().catch(() => null))?.id ?? null

    const trailId = positiveInt(request.get('trail_id') ?? request.get('trailId'))
    const userId = positiveInt(request.get('user_id') ?? request.get('userId'))
    const style = asStyle(request.get('style'))
    const category = asCategory(request.get('category'))
    const direction = asDirection(request.get('direction'))
    const requestedStatus = asStatus(request.get('status'))

    try {
      let query = RouteEffort.query()
      if (trailId)
        query = query.where('trail_id', '=', trailId)
      if (userId)
        query = query.where('user_id', '=', userId)
      if (style)
        query = query.where('style', '=', style)
      if (category)
        query = query.where('category', '=', category)
      if (direction)
        query = query.where('direction', '=', direction)

      // `status=all` is the athlete's own view of their claims; anything else
      // is one status, defaulting to the verified board.
      const statusParam = request.get<string>('status')
      if (requestedStatus)
        query = query.where('status', '=', requestedStatus)
      else if (statusParam !== 'all')
        query = query.where('status', '=', 'verified')

      const rows = (await query.get()) ?? []

      // A rejected claim is visible only to its author and to reviewers.
      // Publishing "we did not believe this person" is a reputational act the
      // site has no business performing on its own.
      const isAdmin = await isAdminUser(viewerId)
      const visible = rows.filter((row: any) =>
        PUBLIC_STATUSES.includes(row.status) || isAdmin || row.user_id === viewerId)

      const shaped = await shapeEfforts(visible)
      // Newest first by whichever clock the row actually has: a finished
      // record sorts by its finish, an attempt still out there by its start.
      shaped.sort((a, b) =>
        Date.parse(b.finishedAt ?? b.startedAt) - Date.parse(a.finishedAt ?? a.startedAt)
        || b.id - a.id)

      const { items, meta } = paginate(shaped, readPageParams(request, { defaultLimit: 30, maxLimit: 100 }))
      return response.json({ success: true, efforts: items, meta })
    }
    catch (error) {
      console.error('[records] index failed:', error)
      return response.json({ success: false, error: 'Failed to fetch records' }, 500)
    }
  },
})

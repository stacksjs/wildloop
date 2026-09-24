// Auth is imported explicitly: it is not in the API server bundle's
// auto-imports (see AuthUserAction). Everything else is auto-imported.
//
// GET /api/me/completed-trails - the trails the signed-in athlete has done:
// ones their activities are on, and saved trails they marked visited. Their
// own only, behind auth: activities can be private, so which trails someone
// walked is not a public read the way their saved list is.

import { Auth } from '@stacksjs/auth'
import { summariseCompletions } from '../../Support/completed-trails'

export default new Action({
  name: 'Completed Trail Index',
  description: 'List the trails the signed-in athlete has completed',
  method: 'GET',

  async handle() {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    try {
      const activities = (await Activity
        .where('user_id', '=', user.id)
        .where('trail_id', '>', 0)
        .get()) ?? []
      const visited = (await SavedTrail
        .where('user_id', '=', user.id)
        .where('has_visited', true)
        .get()) ?? []

      const completions = summariseCompletions(activities as any[], visited as any[])
      const trailIds = completions.map(c => c.trailId)
      const trails = trailIds.length ? await Trail.whereIn('id', trailIds).get() : []
      const trailById = new Map(trails.map((t: any) => [t.id, t]))

      const completedTrails = completions
        .filter(c => trailById.has(c.trailId))
        .map((c) => {
          const t: any = trailById.get(c.trailId)
          return {
            trailId: c.trailId,
            times: c.times,
            lastCompletedAt: c.lastCompletedAt,
            trail: {
              id: t.id,
              name: t.name,
              location: t.location,
              difficulty: t.difficulty,
              distance: t.distance,
              elevation: t.elevation,
              rating: t.rating,
              reviewCount: t.review_count ?? 0,
            },
          }
        })

      return response.json({ success: true, completedTrails })
    }
    catch (error) {
      console.error('[completed-trails] index failed:', error)
      return response.json({ success: false, error: 'Failed to fetch completed trails' }, 500)
    }
  },
})

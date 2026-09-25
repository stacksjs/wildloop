// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// GET /api/users/{id} - public athlete profile: identity, aggregated stats
// (from real activities + territory_stats), social counts, and recent activities.

import { Auth } from '@stacksjs/auth'
import { activityRoutePreview, hiddenEndMetres } from '../../Support/activityRoutePreview'
import { profileFields } from '../../Support/avatars'

export default new Action({
  name: 'Athlete Show',
  description: 'Public athlete profile with aggregated stats',
  method: 'GET',

  async handle(request) {
    const userId = request.get<number>('id')
    if (!userId)
      return response.json({ success: false, error: 'User ID is required' }, 400)

    try {
      const user = await User.find(userId)
      if (!user)
        return response.json({ success: false, error: 'User not found' }, 404)

      // Visibility (#957): everything derived from this athlete's activities -
      // the recent list AND the aggregate totals - must only reflect what the
      // VIEWER is allowed to see, so private mileage never leaks into a public
      // profile. Viewer identity comes only from the authenticated session.
      const viewerId = (await Auth.user().catch(() => null))?.id ?? null
      const blockedIds = await blockedUserIdsFor(viewerId)
      if (blockedIds.has(userId))
        return response.json({ success: false, error: 'User not found' }, 404)
      const viewerFollowing = viewerId !== null
        ? new Set(((await Follow.where('follower_id', '=', viewerId).get()) ?? []).map((f: any) => f.following_id))
        : new Set<number>()
      const allActivities = (await Activity.where('user_id', '=', userId).get()) ?? []
      const activities = allActivities.filter((a: any) => canViewActivity(a, viewerId, viewerFollowing, blockedIds))

      const trailIds = [...new Set(activities.map((a: any) => a.trail_id).filter(Boolean))]
      const trails = trailIds.length ? await Trail.whereIn('id', trailIds).get() : []
      const trailName = new Map(trails.map((t: any) => [t.id, t.name]))
      const trailGeometry = new Map(trails.map((t: any) => [t.id, t.geometry]))

      const totalDistance = activities.reduce((s: number, a: any) => s + (a.distance || 0), 0)
      const totalElevation = activities.reduce((s: number, a: any) => s + (a.elevation || 0), 0)

      const tStats = await TerritoryStats.where('user_id', '=', userId).first()
      const followers = await Follow.where('following_id', '=', userId).get()
      const following = await Follow.where('follower_id', '=', userId).get()

      // The same masked shape the feed draws: a visitor sees where somebody
      // ran without seeing where they start and finish.
      const previewContext = { viewerId, trailGeometry, hideMetres: await hiddenEndMetres([userId]) }

      const recentActivities = [...activities]
        .sort((a: any, b: any) => String(b.completed_at).localeCompare(String(a.completed_at)))
        .slice(0, 8)
        .map((a: any) => ({
          id: a.id,
          activityType: a.activity_type,
          trailName: a.trail_id ? (trailName.get(a.trail_id) ?? null) : null,
          distance: a.distance,
          duration: a.duration,
          elevationGain: a.elevation ?? 0,
          completedAt: a.completed_at,
          route: activityRoutePreview(a, previewContext),
        }))

      return response.json({
        success: true,
        // avatar, bio, location and joinedAt: the public half of a profile.
        user: { id: user.id, name: user.name, ...profileFields(user) },
        stats: {
          activityCount: activities.length,
          totalDistance: Number(totalDistance.toFixed(1)),
          totalElevation,
          territoriesOwned: tStats?.total_territories_owned ?? 0,
          totalArea: tStats?.total_area_owned ?? 0,
          territoriesConquered: tStats?.territories_conquered ?? 0,
          xp: tStats?.xp ?? 0,
        },
        followerCount: (followers ?? []).length,
        followingCount: (following ?? []).length,
        recentActivities,
      })
    }
    catch (error) {
      console.error('Error fetching athlete profile:', error)
      return response.json({ success: false, error: 'Failed to fetch profile' }, 500)
    }
  },
})

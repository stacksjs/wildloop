// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// GET /api/users/search?q= - find athletes by name (#971). With a query of
// 2+ characters it's a case-insensitive LIKE search; with no/shorter query it
// returns the most active athletes as a discover list. Public read; response
// includes enough stats to render discover cards without extra calls.

import { Auth } from '@stacksjs/auth'
import { avatarOf } from '../../Support/avatars'
import { placeOfText } from '../../Support/placeText'
import { milesBetween } from '../../Support/trailRanking'

/** Within this of the visitor, an athlete counts as near them. */
const NEAR_MILES = 60

export default new Action({
  name: 'User Search',
  description: 'Search athletes by name (discover list when no query)',
  method: 'GET',

  async handle(request) {
    const qRaw = request.get<string>('q')
    const q = typeof qRaw === 'string' ? qRaw.trim() : ''

    try {
      const viewerId = (await Auth.user().catch(() => null))?.id ?? null
      const blockedIds = await blockedUserIdsFor(viewerId)
      // Fetch the full match set, then paginate - so meta.total/hasMore reflect
      // the real count (a DB-side .limit() before paginate() would cap total at
      // the page size and make hasMore always false, #978 review).
      const users = q.length >= 2
        ? (await User.where('name', 'like', `%${q}%`).get()) ?? []
        : (await User.query().get()) ?? []

      const visibleUsers = users.filter((user: any) => !blockedIds.has(user.id))
      const ids = visibleUsers.map((u: any) => u.id)
      const activities = ids.length ? (await Activity.whereIn('user_id', ids).get()) ?? [] : []
      const stats = ids.length ? (await TerritoryStats.whereIn('user_id', ids).get()) ?? [] : []
      const followers = ids.length ? (await Follow.whereIn('following_id', ids).get()) ?? [] : []

      const activityCount = new Map<number, number>()
      for (const a of activities)
        activityCount.set(a.user_id, (activityCount.get(a.user_id) ?? 0) + 1)
      const followerCount = new Map<number, number>()
      for (const f of followers)
        followerCount.set(f.following_id, (followerCount.get(f.following_id) ?? 0) + 1)
      const statsByUser = new Map(stats.map((s: any) => [s.user_id, s]))

      // Discover mode can be asked from somewhere (`?lat=&lng=`, the same
      // coarse fix the catalog opens on). Athletes whose public profile town
      // is near it come first. Only a yes/no goes back: nobody's coordinates
      // or distance from the viewer leave the server.
      const lat = Number(request.get('lat'))
      const lng = Number(request.get('lng'))
      const from = q.length < 2 && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
        ? { lat, lng }
        : null
      const isNear = (u: any): boolean => {
        if (!from)
          return false
        const town = placeOfText(u.location)
        return town !== null && milesBetween(from, town.lat, town.lng) <= NEAR_MILES
      }

      const athletes = visibleUsers
        .map((u: any) => ({
          id: u.id,
          name: u.name,
          avatar: avatarOf(u),
          nearYou: isNear(u),
          activityCount: activityCount.get(u.id) ?? 0,
          followerCount: followerCount.get(u.id) ?? 0,
          territoriesOwned: statsByUser.get(u.id)?.total_territories_owned ?? 0,
          totalAreaOwned: statsByUser.get(u.id)?.total_area_owned ?? 0,
        }))
        // Discover mode surfaces the athletes near the viewer, then the most
        // active ones.
        .sort((a: any, b: any) => Number(b.nearYou) - Number(a.nearYou) || b.activityCount - a.activityCount || b.followerCount - a.followerCount || a.id - b.id)

      const paged = paginate(athletes, readPageParams(request, { defaultLimit: 20, maxLimit: 50 }))
      return response.json({ success: true, athletes: paged.items, meta: { ...paged.meta, query: q } })
    }
    catch (error) {
      console.error('[users] search failed:', error)
      return response.json({ success: false, error: 'Failed to search users' }, 500)
    }
  },
})

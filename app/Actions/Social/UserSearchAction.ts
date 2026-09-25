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

      const athletes = visibleUsers
        .map((u: any) => ({
          id: u.id,
          name: u.name,
          avatar: avatarOf(u),
          activityCount: activityCount.get(u.id) ?? 0,
          followerCount: followerCount.get(u.id) ?? 0,
          territoriesOwned: statsByUser.get(u.id)?.total_territories_owned ?? 0,
          totalAreaOwned: statsByUser.get(u.id)?.total_area_owned ?? 0,
        }))
        // Discover mode surfaces the most active athletes first.
        .sort((a: any, b: any) => b.activityCount - a.activityCount || b.followerCount - a.followerCount || a.id - b.id)

      const paged = paginate(athletes, readPageParams(request, { defaultLimit: 20, maxLimit: 50 }))
      return response.json({ success: true, athletes: paged.items, meta: { ...paged.meta, query: q } })
    }
    catch (error) {
      console.error('[users] search failed:', error)
      return response.json({ success: false, error: 'Failed to search users' }, 500)
    }
  },
})

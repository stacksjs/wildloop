import { Auth } from '@stacksjs/auth'
import { avatarOf } from '../../Support/avatars'

const PERIOD_DAYS: Record<string, number | null> = { weekly: 7, monthly: 30, alltime: null }
const METRICS = ['distance', 'elevation', 'activities']

export default new Action({
  name: 'Activity Leaderboard',
  description: 'Server-aggregated activity leaderboard over all eligible public activities',
  method: 'GET',
  async handle(request) {
    const period = PERIOD_DAYS[request.get<string>('period') ?? 'weekly'] === undefined ? 'weekly' : request.get<string>('period') ?? 'weekly'
    const metric = METRICS.includes(request.get<string>('metric')) ? request.get<string>('metric') : 'distance'
    const scope = request.get<string>('scope') === 'following' ? 'following' : 'global'
    const viewerId = (await Auth.user().catch(() => null))?.id ?? null
    const blockedIds = await blockedUserIdsFor(viewerId)
    const following = viewerId
      ? new Set(((await Follow.where('follower_id', '=', viewerId).get()) ?? []).map((row: any) => row.following_id))
      : new Set<number>()
    if (viewerId) following.add(viewerId)

    const days = PERIOD_DAYS[period]
    const cutoff = days ? Date.now() - days * 86400000 : 0
    let query = Activity.query()
    if (scope === 'global')
      query = query.where('visibility', '=', 'public')
    else if (following.size)
      query = query.whereIn('user_id', [...following])
    else
      return response.json({ success: true, period, metric, scope, leaderboard: [] })
    if (days)
      query = query.where('completed_at', '>=', new Date(cutoff).toISOString())
    let activities = (await query.get()) ?? []
    activities = activities.filter((activity: any) => {
      if (blockedIds.has(activity.user_id)) return false
      if (scope === 'following' && !following.has(activity.user_id)) return false
      const visible = activity.visibility === 'public'
        || (scope === 'following' && activity.visibility === 'followers' && following.has(activity.user_id))
        || (scope === 'following' && activity.visibility === 'private' && activity.user_id === viewerId)
      if (!visible) return false
      return new Date(activity.completed_at ?? activity.created_at).getTime() >= cutoff
    })

    const totals = new Map<number, { totalDistance: number, totalElevation: number, activities: number }>()
    for (const activity of activities) {
      const current = totals.get(activity.user_id) ?? { totalDistance: 0, totalElevation: 0, activities: 0 }
      current.totalDistance += activity.distance || 0
      current.totalElevation += activity.elevation || 0
      current.activities++
      totals.set(activity.user_id, current)
    }
    const users = totals.size ? await User.whereIn('id', [...totals.keys()]).get() : []
    const names = new Map(users.map((user: any) => [user.id, user.name]))
    const avatars = new Map(users.map((user: any) => [user.id, avatarOf(user)]))
    const sortValue = (entry: any) => metric === 'elevation'
      ? entry.totalElevation
      : metric === 'activities' ? entry.trailsCompleted : entry.totalDistance
    const leaderboard = [...totals.entries()]
      .map(([userId, total]) => ({
        userId,
        userName: names.get(userId) ?? 'Athlete',
        userAvatar: avatars.get(userId) ?? null,
        totalDistance: Number(total.totalDistance.toFixed(2)),
        totalElevation: Math.round(total.totalElevation),
        trailsCompleted: total.activities,
      }))
      .sort((a, b) => sortValue(b) - sortValue(a) || a.userId - b.userId)
      .slice(0, 100)
      .map((entry, index) => ({ rank: index + 1, ...entry }))
    return response.json({ success: true, period, metric, scope, leaderboard })
  },
})

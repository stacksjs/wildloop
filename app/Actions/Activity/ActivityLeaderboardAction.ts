// `db` is imported the way the other raw-SQL actions import it; the response
// helpers and blockedUserIdsFor are auto-imported as usual.
import type { BoardMetric } from '../../Support/activityLeaderboard'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { activityLeaderboard } from '../../Support/activityLeaderboard'
import { athletesLivingNear, readOrigin } from '../../Support/athletesNear'

const PERIOD_DAYS: Record<string, number | null> = { weekly: 7, monthly: 30, alltime: null }
const METRICS = ['distance', 'elevation', 'activities']

export default new Action({
  name: 'Activity Leaderboard',
  description: 'Server-aggregated activity leaderboard over all eligible public activities',
  method: 'GET',
  async handle(request) {
    const period = PERIOD_DAYS[request.get<string>('period') ?? 'weekly'] === undefined ? 'weekly' : request.get<string>('period') ?? 'weekly'
    const metric = METRICS.includes(request.get<string>('metric')) ? request.get<string>('metric') : 'distance'
    const askedScope = request.get<string>('scope')
    // `local`: the public board, among athletes whose profile town is within
    // 60 miles of `?lat=&lng=`. Without a place to be local to it is global.
    const origin = askedScope === 'local' ? readOrigin(request) : null
    const scope = askedScope === 'following' ? 'following' : origin ? 'local' : 'global'
    const viewerId = (await Auth.user().catch(() => null))?.id ?? null
    const blockedIds = await blockedUserIdsFor(viewerId)
    const run = async (sql: string) => (await db.sql`${db.unsafe(sql)}`.execute() as any[]) ?? []

    const days = PERIOD_DAYS[period]
    const locals = scope === 'local' && origin ? await athletesLivingNear(run, origin) : undefined

    // Summed per athlete in SQL from an index, never loading an activity row
    // or its track (see activityLeaderboard). Who counts is as it was: public
    // activities for the global and local boards, and for following the
    // viewer and the people they follow, their followers-only runs and the
    // viewer's own private ones. Activities with no completed_at fall back to
    // created_at for all time, and blocks hide an athlete either way round.
    const leaderboard = await activityLeaderboard(run, {
      scope,
      viewer: viewerId,
      locals,
      blocked: blockedIds,
      since: days ? Date.now() - days * 86400000 : null,
    }, metric as BoardMetric)
    return response.json({ success: true, period, metric, scope, leaderboard })
  },
})

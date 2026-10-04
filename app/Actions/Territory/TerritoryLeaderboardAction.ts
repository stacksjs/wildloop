// Auth is imported explicitly: it is not in the API server bundle's
// auto-imports (see ActivityStoreAction). Everything else is auto-imported.
//
// NOTE: the ORM is snake_case (rows + sort columns use column names). Reads and
// orderBy fields below use snake_case; JSON output keeps camelCase for the UI.
//
// GET /api/territories/leaderboard?type=area|count|conquests|xp&limit=50
//   Optional min_lat/min_lng/max_lat/max_lng rank only what each player holds
//   inside that box: the board for the viewer's own area.

import { Auth } from '@stacksjs/auth'
import { mapBoundsFromQuery } from '../../../resources/functions/map-area'
import { avatarOf } from '../../Support/avatars'
import { rankTerritoryLeaders, territoryLeaderboardType } from '../../Support/territoryLeaderboard'

const SORT_COLUMNS = {
  area: 'total_area_owned',
  count: 'total_territories_owned',
  conquests: 'territories_conquered',
  xp: 'xp',
} as const

export default new Action({
  name: 'Territory Leaderboard',
  description: 'Get territory leaderboard rankings',
  method: 'GET',

  async handle(request) {
    const type = territoryLeaderboardType(request.get('type'))
    const limit = Math.min(200, Math.max(1, Number(request.get('limit')) || 50))
    const bounds = mapBoundsFromQuery(key => request.get(key))

    try {
      const viewerId = (await Auth.user().catch(() => null))?.id ?? null
      const blockedIds = await blockedUserIdsFor(viewerId)

      // In an area, the land decides who is on the board, so the holders are
      // read from the territories whose centre lies inside it.
      const heldInArea = bounds
        ? ((await Territory.whereIn('status', ['active', 'contested'])
            .where('center_lat', '>=', bounds.minLat)
            .where('center_lat', '<=', bounds.maxLat)
            .where('center_lng', '>=', bounds.minLng)
            .where('center_lng', '<=', bounds.maxLng)
            .get()) ?? []) as any[]
        : undefined

      const holderIds = heldInArea
        ? [...new Set(heldInArea.map(territory => territory.user_id).filter((id): id is number => id != null))]
        : []

      // Deleted and blocked players are filtered after the read, so the read
      // takes more than it needs rather than coming back short.
      const stats = heldInArea
        ? (holderIds.length ? ((await TerritoryStats.whereIn('user_id', holderIds).get()) ?? []) : [])
        : ((await TerritoryStats.whereNotNull('user_id').orderBy(SORT_COLUMNS[type], 'desc').limit(limit * 2 + blockedIds.size).get()) ?? [])

      const userIds = [...new Set([...holderIds, ...stats.map((row: any) => row.user_id)].filter((id): id is number => id != null))]
      const users = userIds.length ? ((await User.whereIn('id', userIds).get()) ?? []) : []

      const leaderboard = rankTerritoryLeaders({
        type,
        limit,
        stats: stats as any[],
        heldInArea,
        blockedIds,
        users: users.map((user: any) => ({ id: user.id, name: user.name, avatar: avatarOf(user) })),
      })

      return response.json({
        success: true,
        type,
        leaderboard,
        meta: {
          total: leaderboard.length,
          sortBy: SORT_COLUMNS[type],
          bounds,
        },
      })
    }
    catch (error) {
      console.error('Error fetching leaderboard:', error)
      return response.json({
        success: false,
        type,
        leaderboard: [],
        error: 'Failed to fetch leaderboard',
      }, 500)
    }
  },
})

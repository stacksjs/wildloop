// No imports needed - everything is auto-imported!
//
// NOTE: the ORM is snake_case (rows + sort columns use column names). Reads and
// orderBy fields below use snake_case; JSON output keeps camelCase for the UI.

import { avatarOf } from '../../Support/avatars'

export default new Action({
  name: 'Territory Leaderboard',
  description: 'Get territory leaderboard rankings',
  method: 'GET',

  async handle(request) {
    const type = request.get('type') || 'area'
    const limit = request.get<number>('limit') || 50

    try {
      let sortField: string
      switch (type) {
        case 'count':
          sortField = 'total_territories_owned'
          break
        case 'conquests':
          sortField = 'territories_conquered'
          break
        case 'xp': // XP leaderboard (#947)
          sortField = 'xp'
          break
        case 'area':
        default:
          sortField = 'total_area_owned'
      }

      const stats = await TerritoryStats.orderBy(sortField, 'desc').limit(limit).get()
      const userIds = stats.map((s: any) => s.user_id)
      const users = await User.whereIn('id', userIds).get()
      const userMap = new Map(users.map((u: any) => [u.id, u]))

      const leaderboard = stats.map((s: any, index: number) => {
        const user = userMap.get(s.user_id)
        return {
          rank: index + 1,
          userId: s.user_id,
          userName: user?.name || 'Unknown',
          userAvatar: avatarOf(user),
          totalTerritoriesOwned: s.total_territories_owned || 0,
          totalAreaOwned: s.total_area_owned || 0,
          territoriesClaimed: s.territories_claimed || 0,
          territoriesConquered: s.territories_conquered || 0,
          territoriesLost: s.territories_lost || 0,
          territoriesDefended: s.territories_defended || 0,
          longestOwnershipDays: s.longest_ownership_days || 0,
          largestTerritoryArea: s.largest_territory_area || 0,
          xp: s.xp || 0,
        }
      })

      return response.json({
        success: true,
        type,
        leaderboard,
        meta: {
          total: leaderboard.length,
          sortBy: sortField,
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

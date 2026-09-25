// No imports needed - everything is auto-imported!
//
// NOTE: the ORM is snake_case (rows + where/orderBy columns use column names).
// Reads below use snake_case; JSON output keeps camelCase for the UI.

import { avatarOf } from '../../Support/avatars'

export default new Action({
  name: 'User Territories',
  description: 'Get all territories owned by a specific user',
  method: 'GET',

  async handle(request) {
    const userId = request.get<number>('user_id')

    if (!userId) {
      return response.json({ success: false, error: 'User ID is required' }, 400)
    }

    try {
      const user = await User.find(userId)
      if (!user) {
        return response.json({ success: false, error: 'User not found' }, 404)
      }

      // Contested territories still belong to the user (and they especially
      // need to see them - they're under attack/decaying); only expired
      // territories drop out of the list.
      const territories = await Territory
        .where('user_id', '=', userId)
        .whereIn('status', ['active', 'contested'])
        .orderBy('area_size', 'desc')
        .get()

      const stats = await TerritoryStats.where('user_id', '=', userId).first()

      const formattedTerritories = territories.map((t: any) => ({
        id: t.id,
        name: t.name,
        areaSize: t.area_size,
        perimeter: t.perimeter,
        centerLat: t.center_lat,
        centerLng: t.center_lng,
        conquestCount: t.conquest_count,
        claimedAt: t.claimed_at,
        status: t.status,
        polygon: t.polygon_data ? JSON.parse(t.polygon_data) : null,
      }))

      return response.json({
        success: true,
        user: {
          id: user.id,
          name: user.name,
          avatar: avatarOf(user),
        },
        territories: formattedTerritories,
        stats: stats
          ? {
              totalTerritoriesOwned: stats.total_territories_owned || 0,
              totalAreaOwned: stats.total_area_owned || 0,
              territoriesClaimed: stats.territories_claimed || 0,
              territoriesConquered: stats.territories_conquered || 0,
              territoriesLost: stats.territories_lost || 0,
              territoriesDefended: stats.territories_defended || 0,
              longestOwnershipDays: stats.longest_ownership_days || 0,
              largestTerritoryArea: stats.largest_territory_area || 0,
              weeklyRank: stats.weekly_rank || 0,
              allTimeRank: stats.all_time_rank || 0,
            }
          : null,
        meta: {
          total: formattedTerritories.length,
        },
      })
    }
    catch (error) {
      console.error('Error fetching user territories:', error)
      return response.json({
        success: false,
        error: 'Failed to fetch user territories',
      }, 500)
    }
  },
})

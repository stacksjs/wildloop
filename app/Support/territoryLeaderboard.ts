/**
 * Who leads the territory game, from the rows the leaderboard action reads.
 *
 * Kept free of the database so the rules are testable on their own:
 *
 *  - Only real, current players. `territory_stats` outlives its user in two
 *    ways — an account deleted before deletion learned to remove the row, and
 *    a row whose `user_id` was nulled — and both ranked as "Unknown". On
 *    production they held most of the top twenty-five.
 *  - Blocks hide a player from the board in both directions, as they do on
 *    every other leaderboard and on the game map.
 *  - A player with nothing on the chosen measure is not a leader. Every
 *    account that ever opened the game has a zeroed row.
 *  - Given the territories in an area, the board ranks what each player holds
 *    there, so "near you" is the ground around the viewer rather than an
 *    empire built three states away.
 */

export type TerritoryLeaderboardType = 'area' | 'count' | 'conquests' | 'xp'

export interface TerritoryStatsRow {
  user_id: number | null
  total_territories_owned?: number | null
  total_area_owned?: number | null
  territories_claimed?: number | null
  territories_conquered?: number | null
  territories_lost?: number | null
  territories_defended?: number | null
  longest_ownership_days?: number | null
  largest_territory_area?: number | null
  xp?: number | null
}

export interface HeldTerritoryRow {
  user_id: number | null
  area_size?: number | null
}

export interface LeaderboardUser {
  id: number
  name?: string | null
  avatar: string | null
}

export interface TerritoryLeader {
  rank: number
  userId: number
  userName: string
  userAvatar: string | null
  totalTerritoriesOwned: number
  totalAreaOwned: number
  territoriesClaimed: number
  territoriesConquered: number
  territoriesLost: number
  territoriesDefended: number
  longestOwnershipDays: number
  largestTerritoryArea: number
  xp: number
}

export function territoryLeaderboardType(value: unknown): TerritoryLeaderboardType {
  return value === 'count' || value === 'conquests' || value === 'xp' ? value : 'area'
}

export function rankTerritoryLeaders(input: {
  type: TerritoryLeaderboardType
  stats: TerritoryStatsRow[]
  users: LeaderboardUser[]
  blockedIds: Set<number>
  limit: number
  /** Territories in the area asked about; omitted for the whole board. */
  heldInArea?: HeldTerritoryRow[]
}): TerritoryLeader[] {
  const users = new Map(input.users.map(user => [user.id, user]))
  const stats = new Map<number, TerritoryStatsRow>()
  for (const row of input.stats) {
    if (row.user_id != null)
      stats.set(row.user_id, row)
  }

  // In an area, holdings are counted from the land itself, and only the
  // players who hold some of it are on the board.
  const local = input.heldInArea
    ? input.heldInArea.reduce((held, territory) => {
        if (territory.user_id == null)
          return held
        const current = held.get(territory.user_id) ?? { count: 0, area: 0 }
        held.set(territory.user_id, { count: current.count + 1, area: current.area + (territory.area_size ?? 0) })
        return held
      }, new Map<number, { count: number, area: number }>())
    : null

  const candidates = local ? [...local.keys()] : [...stats.keys()]

  const leaders = candidates
    .filter(userId => users.has(userId) && !input.blockedIds.has(userId))
    .map((userId) => {
      const row = stats.get(userId) ?? { user_id: userId }
      const user = users.get(userId)!
      const held = local?.get(userId)
      return {
        rank: 0,
        userId,
        userName: user.name || 'Athlete',
        userAvatar: user.avatar,
        totalTerritoriesOwned: held ? held.count : row.total_territories_owned || 0,
        totalAreaOwned: held ? held.area : row.total_area_owned || 0,
        territoriesClaimed: row.territories_claimed || 0,
        territoriesConquered: row.territories_conquered || 0,
        territoriesLost: row.territories_lost || 0,
        territoriesDefended: row.territories_defended || 0,
        longestOwnershipDays: row.longest_ownership_days || 0,
        largestTerritoryArea: row.largest_territory_area || 0,
        xp: row.xp || 0,
      }
    })

  const measure = (leader: TerritoryLeader): number => {
    if (input.type === 'count')
      return leader.totalTerritoriesOwned
    if (input.type === 'conquests')
      return leader.territoriesConquered
    if (input.type === 'xp')
      return leader.xp
    return leader.totalAreaOwned
  }

  return leaders
    .filter(leader => measure(leader) > 0)
    .sort((a, b) => measure(b) - measure(a) || b.totalAreaOwned - a.totalAreaOwned || a.userId - b.userId)
    .slice(0, input.limit)
    .map((leader, index) => ({ ...leader, rank: index + 1 }))
}

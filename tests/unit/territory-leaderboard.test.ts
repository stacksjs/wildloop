import { describe, expect, it } from 'bun:test'
import { rankTerritoryLeaders, territoryLeaderboardType } from '../../app/Support/territoryLeaderboard'

const users = [
  { id: 1, name: 'Alice', avatar: null },
  { id: 2, name: 'Bob', avatar: null },
  { id: 3, name: 'Cara', avatar: null },
]

describe('territory leaderboard', () => {
  it('leaves out rows whose player no longer exists', () => {
    // Production ranked these as "Unknown" in most of its top twenty-five.
    const leaders = rankTerritoryLeaders({
      type: 'area',
      limit: 10,
      blockedIds: new Set(),
      users,
      stats: [
        { user_id: null, total_area_owned: 4_860_412 },
        { user_id: 99, total_area_owned: 4_000_000 },
        { user_id: 1, total_area_owned: 50_000, total_territories_owned: 2 },
      ],
    })
    expect(leaders.map(leader => leader.userId)).toEqual([1])
    expect(leaders[0].rank).toBe(1)
  })

  it('hides blocked players and players with nothing to rank', () => {
    const leaders = rankTerritoryLeaders({
      type: 'xp',
      limit: 10,
      blockedIds: new Set([2]),
      users,
      stats: [
        { user_id: 1, xp: 300 },
        { user_id: 2, xp: 900 },
        { user_id: 3, xp: 0 },
      ],
    })
    expect(leaders.map(leader => leader.userId)).toEqual([1])
  })

  it('ranks only what each player holds in the area asked about', () => {
    const leaders = rankTerritoryLeaders({
      type: 'area',
      limit: 10,
      blockedIds: new Set(),
      users,
      // Cara's empire is elsewhere; locally Bob holds more than Alice.
      stats: [
        { user_id: 1, total_area_owned: 90_000, total_territories_owned: 3, xp: 500 },
        { user_id: 2, total_area_owned: 40_000, total_territories_owned: 1, xp: 200 },
        { user_id: 3, total_area_owned: 9_000_000, total_territories_owned: 40, xp: 9_000 },
      ],
      heldInArea: [
        { user_id: 1, area_size: 20_000 },
        { user_id: 2, area_size: 25_000 },
        { user_id: 2, area_size: 15_000 },
      ],
    })
    expect(leaders.map(leader => [leader.userId, leader.totalTerritoriesOwned, leader.totalAreaOwned]))
      .toEqual([[2, 2, 40_000], [1, 1, 20_000]])
    // Lifetime figures still come from the player's record.
    expect(leaders[1].xp).toBe(500)
  })

  it('reads an unknown type as the area board', () => {
    expect(territoryLeaderboardType('conquests')).toBe('conquests')
    expect(territoryLeaderboardType('total_area_owned; drop table')).toBe('area')
    expect(territoryLeaderboardType(undefined)).toBe('area')
  })
})

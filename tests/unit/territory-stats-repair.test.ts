import { describe, expect, it } from 'bun:test'
import { computeTerritoryStatsFixes } from '../../resources/functions/counters'

/**
 * Rebuilding players' territory holdings from the territories themselves.
 *
 * Claims, battles and decay each move holdings by a delta. A delta clamped at
 * zero, or applied twice, leaves the row wrong for good; production had 20 of
 * its top 25 leaderboard rows belonging to players who no longer existed.
 */
const users = new Set([1, 2, 3])

describe('territory holdings', () => {
  it('leaves a row that matches what the player holds', () => {
    const fixes = computeTerritoryStatsFixes({
      stats: [{ id: 10, user_id: 1, total_territories_owned: 2, total_area_owned: 5000, largest_territory_area: 3000 }],
      holdings: [{ user_id: 1, owned: 2, area: 5000.2, largest: 3000 }],
      userIds: users,
    })
    expect(fixes).toEqual({ updates: [], orphans: [], missing: [] })
  })

  it('rebuilds holdings that drifted', () => {
    const fixes = computeTerritoryStatsFixes({
      stats: [{ id: 10, user_id: 1, total_territories_owned: 0, total_area_owned: 0, largest_territory_area: 9000 }],
      holdings: [{ user_id: 1, owned: 3, area: 7200, largest: 4000 }],
      userIds: users,
    })
    // Largest is a lifetime best: it stays at 9,000 although nothing that size is held now.
    expect(fixes.updates).toEqual([{ id: 10, total_territories_owned: 3, total_area_owned: 7200, largest_territory_area: 9000 }])
  })

  it('empties the holdings of a player who holds nothing', () => {
    const fixes = computeTerritoryStatsFixes({
      stats: [{ id: 11, user_id: 2, total_territories_owned: 4, total_area_owned: 12000, largest_territory_area: 5000 }],
      holdings: [],
      userIds: users,
    })
    expect(fixes.updates).toEqual([{ id: 11, total_territories_owned: 0, total_area_owned: 0, largest_territory_area: 5000 }])
  })

  it('removes rows for players who no longer exist', () => {
    const fixes = computeTerritoryStatsFixes({
      stats: [
        { id: 12, user_id: 99, total_territories_owned: 5 },
        { id: 13, user_id: null },
        { id: 14, user_id: 3, total_territories_owned: 0, total_area_owned: 0, largest_territory_area: 0 },
      ],
      holdings: [],
      userIds: users,
    })
    expect(fixes.orphans).toEqual([12, 13])
    expect(fixes.updates).toEqual([])
  })

  it('creates a row for a player who holds ground and has none', () => {
    const fixes = computeTerritoryStatsFixes({
      stats: [],
      holdings: [{ user_id: 2, owned: 1, area: 2500, largest: 2500 }, { user_id: 77, owned: 1, area: 900, largest: 900 }],
      userIds: users,
    })
    // Player 77 is gone; their land is not a reason to invent a row for them.
    expect(fixes.missing).toEqual([{ user_id: 2, owned: 1, area: 2500, largest: 2500 }])
  })
})

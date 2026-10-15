import { describe, expect, it } from 'bun:test'
import {
  filterTerritories,
  matchesTerritoryFilter,
  territoriesMapPath,
  territoryBadge,
  territoryGeometry,
  territoryLeaderboard,
  territoryOwnerLine,
  territoryRowsFrom,
  zonesHeldText,
} from '../../resources/functions/territories'

/**
 * The reading half of the territory map, added when `/territories` was
 * promoted to a native screen.
 *
 * Two things here are the kind that fail silently. A GeoJSON ring is
 * `[lng, lat]` and everything that draws it wants `[lat, lng]`, so getting the
 * swap backwards moves San Diego to the Indian Ocean without an error. And the
 * query is built with `encodeURIComponent` because the native runtime has no
 * `URLSearchParams` — a screen that builds one issues no request at all.
 */

const ME = 12

const MAP_PAYLOAD = {
  features: [
    {
      properties: {
        id: 1,
        name: 'Balboa Loop',
        ownerId: ME,
        ownerName: 'Glenn',
        areaSize: 240_000,
        conquestCount: 2,
        defendCount: 5,
        claimedAt: '2026-10-01T07:00:00.000Z',
        status: 'active',
        centerLat: 32.73,
        centerLng: -117.15,
      },
      // GeoJSON order: [lng, lat].
      geometry: { type: 'Polygon', coordinates: [[[-117.16, 32.72], [-117.14, 32.72], [-117.14, 32.74]]] },
    },
    {
      properties: {
        id: 2,
        name: 'Switchback Ridge',
        ownerId: 44,
        ownerName: 'Marta',
        areaSize: 900_000,
        conquestCount: 0,
        defendCount: 1,
        claimedAt: '2026-10-02T07:00:00.000Z',
        status: 'contested',
        centerLat: 32.80,
        centerLng: -117.20,
      },
      geometry: { type: 'Polygon', coordinates: [[[-117.21, 32.79], [-117.19, 32.79], [-117.19, 32.81]]] },
    },
  ],
}

describe('territoriesMapPath', () => {
  it('asks for the whole limit with no viewport', () => {
    expect(territoriesMapPath()).toBe('/api/territories/map?limit=500')
  })

  it('carries a viewport as four bounds', () => {
    const path = territoriesMapPath({ minLat: 32.7, minLng: -117.2, maxLat: 32.8, maxLng: -117.1 })

    expect(path).toBe('/api/territories/map?limit=500&min_lat=32.7&min_lng=-117.2&max_lat=32.8&max_lng=-117.1')
  })

  /*
   * The rule from CLAUDE.md, asserted rather than trusted: no web API may
   * appear in the string this builds, because the native runtime defines none.
   */
  it('builds a plain string a native screen can issue', () => {
    expect(territoriesMapPath({ minLat: 1, minLng: 2, maxLat: 3, maxLng: 4 })).not.toContain('[object')
    expect(String(territoriesMapPath())).toStartWith('/api/')
  })
})

describe('territoryRowsFrom', () => {
  it('flattens a feature into a row', () => {
    const [first] = territoryRowsFrom(MAP_PAYLOAD)

    expect(first).toMatchObject({
      id: 1,
      name: 'Balboa Loop',
      userId: ME,
      ownerName: 'Glenn',
      areaSize: 240_000,
      conquestCount: 2,
      defendCount: 5,
      status: 'active',
    })
  })

  /*
   * The swap. A ring read in GeoJSON order puts a San Diego territory at
   * latitude -117, which is not a latitude at all — and nothing throws.
   */
  it('reorders the ring from [lng, lat] to [lat, lng]', () => {
    const [first] = territoryRowsFrom(MAP_PAYLOAD)

    expect(first.ring).toEqual([[32.72, -117.16], [32.72, -117.14], [32.74, -117.14]])
    for (const [lat, lng] of first.ring!) {
      expect(Math.abs(lat)).toBeLessThanOrEqual(90)
      expect(Math.abs(lng)).toBeGreaterThan(90)
    }
  })

  it('keeps a feature with no geometry, with no ring', () => {
    const rows = territoryRowsFrom({ features: [{ properties: { id: 9, ownerId: 1 }, geometry: null }] })

    expect(rows).toHaveLength(1)
    expect(rows[0].ring).toBeNull()
    expect(rows[0].name).toBe('Territory #9')
  })

  it('reads an unsettled zone as contested, and anything else as active', () => {
    expect(territoryRowsFrom(MAP_PAYLOAD)[1].status).toBe('contested')
    expect(territoryRowsFrom({ features: [{ properties: { id: 1, status: 'whatever' } }] })[0].status).toBe('active')
  })

  it('survives a payload that is not what it should be', () => {
    for (const payload of [null, undefined, {}, 'nope', { features: 'nope' }, { features: [null, {}] }])
      expect(territoryRowsFrom(payload)).toEqual([])
  })
})

describe('territoryGeometry', () => {
  it('flattens a ring and closes it', () => {
    const flat = territoryGeometry([[32.72, -117.16], [32.72, -117.14], [32.74, -117.14]])

    expect(flat).toEqual([32.72, -117.16, 32.72, -117.14, 32.74, -117.14, 32.72, -117.16])
  })

  /*
   * craft-native has MapPolyline and MapMarker and no polygon, so a zone is a
   * polyline closed by repeating its first point. A ring that already closes
   * must not get a duplicate.
   */
  it('does not double the last point of an already-closed ring', () => {
    const closed: [number, number][] = [[1, 2], [3, 4], [5, 6], [1, 2]]

    expect(territoryGeometry(closed)).toEqual([1, 2, 3, 4, 5, 6, 1, 2])
  })

  it('has nothing to draw without at least two points', () => {
    expect(territoryGeometry(null)).toEqual([])
    expect(territoryGeometry([])).toEqual([])
    expect(territoryGeometry([[1, 2]])).toEqual([])
  })
})

describe('filterTerritories', () => {
  const rows = territoryRowsFrom(MAP_PAYLOAD)

  it('shows everything under all', () => {
    expect(filterTerritories(rows, 'all', ME)).toHaveLength(2)
  })

  it('shows only the viewer\'s own under mine', () => {
    expect(filterTerritories(rows, 'mine', ME).map(row => row.id)).toEqual([1])
  })

  it('shows nothing of the viewer\'s own when they are nobody', () => {
    expect(filterTerritories(rows, 'mine', null)).toEqual([])
  })

  it('shows only unsettled ground under contested', () => {
    expect(filterTerritories(rows, 'contested', ME).map(row => row.id)).toEqual([2])
  })

  it('reads one row the same way', () => {
    expect(matchesTerritoryFilter(rows[0], 'mine', ME)).toBe(true)
    expect(matchesTerritoryFilter(rows[0], 'contested', ME)).toBe(false)
  })
})

describe('territoryLeaderboard', () => {
  const rows = territoryRowsFrom(MAP_PAYLOAD)

  it('ranks holders by the ground they hold', () => {
    const board = territoryLeaderboard(rows)

    expect(board.map(holder => holder.userId)).toEqual([44, ME])
    expect(board[0]).toMatchObject({ rank: 1, userName: 'Marta', zones: 1, area: 900_000 })
    expect(board[1].rank).toBe(2)
  })

  it('sums several zones held by one athlete', () => {
    const doubled = [...rows, { ...rows[0], id: 3, areaSize: 60_000 }]
    const mine = territoryLeaderboard(doubled).find(holder => holder.userId === ME)!

    expect(mine).toMatchObject({ zones: 2, area: 300_000 })
  })

  /*
   * Built from the territories, not from a roster — otherwise a player with no
   * land nearby is shown a top ten of strangers each holding nothing.
   */
  it('lists nobody who holds nothing', () => {
    expect(territoryLeaderboard([])).toEqual([])
  })

  it('breaks a tie the same way on every client', () => {
    const tied = [
      { ...rows[0], id: 5, userId: 99, areaSize: 100 },
      { ...rows[0], id: 6, userId: 7, areaSize: 100 },
    ]

    expect(territoryLeaderboard(tied).map(holder => holder.userId)).toEqual([7, 99])
  })

  it('holds the board to its limit', () => {
    const many = Array.from({ length: 25 }, (_, index) => ({ ...rows[0], id: index + 10, userId: index + 100 }))

    expect(territoryLeaderboard(many)).toHaveLength(10)
  })
})

describe('what a zone is called', () => {
  const rows = territoryRowsFrom(MAP_PAYLOAD)

  it('names whose it is', () => {
    expect(territoryBadge(rows[0], ME)).toBe('Yours')
    expect(territoryBadge(rows[1], ME)).toBe('Contested')
    expect(territoryBadge({ ...rows[1], status: 'active' }, ME)).toBe('Enemy')
  })

  it('reads the viewer as themselves', () => {
    expect(territoryOwnerLine(rows[0], ME)).toBe('You')
    expect(territoryOwnerLine(rows[1], ME)).toBe('Marta')
  })

  it('counts zones in the singular where it should', () => {
    expect(zonesHeldText(1)).toBe('1 zone held')
    expect(zonesHeldText(4)).toBe('4 zones held')
  })
})

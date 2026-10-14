import { describe, expect, it } from 'bun:test'
import {
  trailAscentText,
  trailDistanceText,
  trailPath,
  trailPlaceLine,
  trailRoutePoints,
  trailRowsFrom,
  trailsPath,
  trailStatsLine,
} from '../../resources/functions/trails'

/**
 * The trail catalog, as both screens compute it.
 *
 * Extracted from `resources/views/trails.stx` and `useTrailCatalog` when the
 * native screen became the second consumer. The path matters most: the web
 * built it with `URLSearchParams`, which a native screen does not have, and
 * that exact mistake made the leaderboard screen issue no request at all while
 * every browser test passed.
 */

const ROW = {
  id: 7,
  name: 'Eagle Creek Loop',
  location: 'Columbia River Gorge, Oregon',
  latitude: 45.64,
  longitude: -121.92,
  distance: 12.4,
  elevation: 1680,
  difficulty: 'hard',
  routeType: 'loop',
  managedBy: 'Mount Hood National Forest',
  geometry: JSON.stringify([[45.64, -121.92], [45.66, -121.9], [45.64, -121.92]]),
}

describe('trailsPath', () => {
  it('builds the query without URLSearchParams, which a native screen lacks', () => {
    expect(trailsPath({ q: 'eagle creek' })).toBe('/api/trails?q=eagle%20creek&limit=60&offset=0')
  })

  it('escapes what a place name can actually contain', () => {
    expect(trailsPath({ q: 'Großer Arber & Co' })).toContain('q=Gro%C3%9Fer%20Arber%20%26%20Co')
  })

  it('drops a blank search rather than sending an empty parameter', () => {
    expect(trailsPath({ q: '   ' })).toBe('/api/trails?limit=60&offset=0')
  })

  it('reads `all` as no filter, the way the API does', () => {
    expect(trailsPath({ difficulty: 'all', routeType: 'all' })).toBe('/api/trails?limit=60&offset=0')
    expect(trailsPath({ difficulty: 'hard' })).toContain('difficulty=hard')
  })

  it('defaults to the page size the website has always asked for', () => {
    expect(trailsPath({})).toContain('limit=60')
  })

  it('carries the whole filter bar, so the website cannot drift from the screen', () => {
    expect(trailsPath({ minDistance: 3, maxDistance: 10, minRating: 4, dogsAllowed: true, accessible: true, nationalTrail: true, country: 'DE', state: 'BY', sort: 'nearest' }))
      .toBe('/api/trails?country=DE&state=BY&sort=nearest&minDistance=3&maxDistance=10&minRating=4&dogsAllowed=true&accessible=true&nationalTrail=true&limit=60&offset=0')
  })

  it('rounds a near-me origin so a neighbourhood shares one cached answer', () => {
    expect(trailsPath({ lat: 45.6412345, lng: -121.9212345, radius: 25 }))
      .toContain('lat=45.64&lng=-121.92&radius=25')
  })

  it('ignores one half of a coordinate, the way the API does', () => {
    expect(trailsPath({ lat: 45.64 })).toBe('/api/trails?limit=60&offset=0')
  })

  it('drops a zero rating, which is the filter being off', () => {
    expect(trailsPath({ minRating: 0 })).toBe('/api/trails?limit=60&offset=0')
  })

  it('always carries a limit and an offset, so a page is a page', () => {
    expect(trailsPath({ limit: 5, offset: 10 })).toBe('/api/trails?limit=5&offset=10')
    expect(trailsPath({ offset: -3 })).toContain('offset=0')
  })
})

describe('trailRowsFrom', () => {
  it('takes the rows and each trail\'s line', () => {
    const result = trailRowsFrom({ trails: [ROW], meta: { total: 412, hasMore: true } })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].name).toBe('Eagle Creek Loop')
    expect(result.routeById[7]).toHaveLength(3)
    expect(result.total).toBe(412)
    expect(result.hasMore).toBe(true)
  })

  it('falls back to the row count when the API sends no total', () => {
    const result = trailRowsFrom({ trails: [ROW] })

    expect(result.total).toBe(1)
    expect(result.hasMore).toBe(false)
  })

  it('survives a payload that is not what it should be', () => {
    for (const payload of [null, undefined, {}, 'nope', { trails: 'nope' }]) {
      const result = trailRowsFrom(payload)
      expect(result.rows).toEqual([])
      expect(result.total).toBe(0)
    }
  })

  it('leaves out a trail with no coordinates rather than placing it at zero', () => {
    const result = trailRowsFrom({ trails: [{ id: 9, name: 'Nowhere' }] })

    expect(result.rows).toEqual([])
  })

  it('holds no line for a trail the catalog has no geometry for', () => {
    const result = trailRowsFrom({ trails: [{ ...ROW, geometry: null }] })

    expect(result.rows).toHaveLength(1)
    expect(result.routeById[7]).toBeUndefined()
  })
})

describe('the numbers, as a row reads them', () => {
  it('gives miles one decimal, and drops a pointless one', () => {
    expect(trailDistanceText(4.25)).toBe('4.3 mi')
    expect(trailDistanceText(3)).toBe('3 mi')
    expect(trailDistanceText(12.4)).toBe('12 mi')
  })

  it('separates thousands of feet', () => {
    expect(trailAscentText(1680)).toBe('1,680 ft')
  })

  it('says nothing about an ascent that is not on record', () => {
    expect(trailAscentText(0)).toBe('')
    expect(trailAscentText(null)).toBe('')
    expect(trailDistanceText(0)).toBe('')
  })

  it('joins distance, ascent and route type on one line', () => {
    const [row] = trailRowsFrom({ trails: [ROW] }).rows

    expect(trailStatsLine(row)).toBe('12 mi · 1,680 ft · Loop')
  })

  it('leaves out the parts a trail does not have, with no stray separator', () => {
    const [row] = trailRowsFrom({ trails: [{ ...ROW, elevation: 0, routeType: '' }] }).rows

    expect(trailStatsLine(row)).toBe('12 mi')
  })
})

describe('trailPlaceLine', () => {
  it('prefers the location the row already spells out', () => {
    expect(trailPlaceLine({ location: 'Columbia River Gorge, Oregon', managedBy: 'Mount Hood NF' }))
      .toBe('Columbia River Gorge, Oregon')
  })

  it('falls back to the agency, then the region, then nothing', () => {
    expect(trailPlaceLine({ location: '', managedBy: 'Mount Hood NF' })).toBe('Mount Hood NF')
    expect(trailPlaceLine({ location: '', managedBy: '', stateName: 'Oregon' })).toBe('Oregon')
    expect(trailPlaceLine({})).toBe('')
    expect(trailPlaceLine(null)).toBe('')
  })
})

describe('trailRoutePoints', () => {
  it('projects the line into the box the row draws', () => {
    const points = trailRoutePoints([[45.64, -121.92], [45.66, -121.9]])
    const pairs = points.split(' ')

    expect(pairs).toHaveLength(2)
    for (const pair of pairs) {
      const [x, y] = pair.split(',').map(Number)
      expect(x).toBeGreaterThanOrEqual(0)
      expect(x).toBeLessThanOrEqual(96)
      expect(y).toBeGreaterThanOrEqual(0)
      expect(y).toBeLessThanOrEqual(64)
    }
  })

  it('draws nothing when there is no line to draw', () => {
    expect(trailRoutePoints(null)).toBe('')
    expect(trailRoutePoints([])).toBe('')
    expect(trailRoutePoints([[45.64, -121.92]])).toBe('')
  })
})

describe('trailPath', () => {
  it('points at the trail\'s own page, which stays the website', () => {
    expect(trailPath(7)).toBe('/trail/7')
  })
})

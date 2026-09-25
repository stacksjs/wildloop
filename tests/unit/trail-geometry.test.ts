import type { Coordinate } from '../../resources/functions/geo'
import type { EsriFeature } from '../../app/Ingest/sources/arcgis'
import { describe, expect, it } from 'bun:test'
import { encodeRouteGeometry, networkStats } from '../../app/Ingest/normalize'
import { clusterRuns, featureRoutes, pathsToSegments } from '../../app/Ingest/sources/arcgis'
import { elementRoute } from '../../app/Ingest/sources/osm'
import { normalizeTrailsPayload, parseTrailGeometry, parseTrailGeometryParts } from '../../resources/assets/scripts/trail-data'
import { haversineDistance } from '../../resources/functions/geo'
import {
  decodeRouteParts,
  encodeRouteParts,
  lineLengthMeters,
  primaryRoutePart,
  ROUTE_SNAP_METERS,
  routePartsFromSegments,
} from '../../resources/functions/trail-geometry'
import rockRidge from '../fixtures/nps-rock-ridge-trail-west.json'

const M = 1 / 111_320

/** A straight run of `count` points `step` metres apart, heading by (dLat, dLng) unit metres. */
function run(start: Coordinate, count: number, dLatM: number, dLngM: number, step = 10): Coordinate[] {
  const cos = Math.cos((start.lat * Math.PI) / 180)
  return Array.from({ length: count }, (_, i) => ({
    lat: start.lat + (i * step * dLatM) * M,
    lng: start.lng + (i * step * dLngM) * M / cos,
  }))
}

const key = (p: Coordinate) => `${p.lat.toFixed(7)},${p.lng.toFixed(7)}`

/**
 * Every step of every drawn part is either a step that exists in the source
 * pieces (in either direction) or a junction snap no longer than the snap
 * distance. This is the property the whole module exists for: nothing is drawn
 * that the source did not draw.
 */
function expectNoInventedSteps(parts: Coordinate[][], source: Coordinate[][]): void {
  const real = new Set<string>()
  for (const piece of source) {
    for (let i = 1; i < piece.length; i++) {
      real.add(`${key(piece[i - 1])}>${key(piece[i])}`)
      real.add(`${key(piece[i])}>${key(piece[i - 1])}`)
    }
  }
  for (const part of parts) {
    for (let i = 1; i < part.length; i++) {
      const step = `${key(part[i - 1])}>${key(part[i])}`
      if (!real.has(step))
        expect(haversineDistance(part[i - 1], part[i])).toBeLessThanOrEqual(ROUTE_SNAP_METERS)
    }
  }
}

function maxStep(line: Coordinate[]): number {
  let max = 0
  for (let i = 1; i < line.length; i++)
    max = Math.max(max, haversineDistance(line[i - 1], line[i]))
  return max
}

describe('Rock Ridge Trail West (NPS SAMO, wildloop.org/trail/6139)', () => {
  const features = rockRidge.features as Array<EsriFeature<unknown>>
  const source = features.flatMap(feature => pathsToSegments(feature.geometry?.paths))

  it('is one trail in one part, drawn only along its own segments', () => {
    const routes = featureRoutes(features)
    expect(routes).toHaveLength(1)
    const [network] = routes
    expect(network.parts).toHaveLength(1)
    expectNoInventedSteps(network.parts, source)
    // The stored line had an 817 m straight hop from Lindero Canyon Road
    // across the houses; the longest step in the source data is ~116 m.
    expect(maxStep(network.parts[0])).toBeLessThan(120)
  })

  it('measures distinct trail, not the gaps it used to jump', () => {
    const [network] = featureRoutes(features)
    const segmentsTotal = source.reduce((sum, segment) => sum + lineLengthMeters(segment), 0)
    expect(network.lengthMeters).toBeCloseTo(segmentsTotal, 0)
    // Stored as 2.04 mi with the hops counted; the six segments are 1.46 mi.
    expect(networkStats(network).distanceMiles).toBe(1.46)
  })

  it('covers every segment', () => {
    const [network] = featureRoutes(features)
    const drawn = new Set(network.parts.flat().map(key))
    for (const segment of source) {
      expect(drawn.has(key(segment[0]))).toBe(true)
      expect(drawn.has(key(segment[segment.length - 1]))).toBe(true)
    }
  })

  it('stores within the point budget and reads back as one line', () => {
    const [network] = featureRoutes(features)
    const stored = encodeRouteGeometry(network.parts)
    expect(decodeRouteParts(stored)).toHaveLength(1)
    expect(decodeRouteParts(stored)[0].length).toBeLessThanOrEqual(151)
  })
})

describe('routePartsFromSegments', () => {
  const origin = { lat: 34.18, lng: -118.78 }

  it('chains shuffled, reversed pieces of one line back into that line', () => {
    const line = run(origin, 40, 1, 0.3)
    const pieces = [line.slice(20, 30), line.slice(0, 11).reverse(), line.slice(29), line.slice(10, 21).reverse()]
    const { parts, lengthMeters } = routePartsFromSegments(pieces)
    expect(parts).toHaveLength(1)
    const drawn = parts[0]
    const oriented = key(drawn[0]) === key(line[0]) ? drawn : [...drawn].reverse()
    expect(oriented.map(key)).toEqual(line.map(key))
    expect(lengthMeters).toBeCloseTo(lineLengthMeters(line), 3)
  })

  it('keeps the direction of a line that is already in order', () => {
    const line = run(origin, 30, 0, 1)
    const { parts } = routePartsFromSegments([line.slice(0, 16), line.slice(15)])
    expect(key(parts[0][0])).toBe(key(line[0]))
  })

  it('never bridges a gap wider than the snap distance', () => {
    const west = run(origin, 20, 0, 1)
    const eastStart = { lat: origin.lat, lng: west[19].lng + 200 * M / Math.cos((origin.lat * Math.PI) / 180) }
    const east = run(eastStart, 10, 0, 1)
    const { parts, lengthMeters } = routePartsFromSegments([east, west])
    expect(parts).toHaveLength(2)
    // Longest first.
    expect(parts[0]).toHaveLength(20)
    for (const part of parts)
      expect(maxStep(part)).toBeLessThanOrEqual(10.01)
    expect(lengthMeters).toBeCloseTo(lineLengthMeters(west) + lineLengthMeters(east), 3)
  })

  it('snaps ends that nearly meet into one junction', () => {
    const first = run(origin, 10, 1, 0)
    const gapStart = { lat: first[9].lat + 12 * M, lng: first[9].lng }
    const second = run(gapStart, 10, 1, 0)
    const { parts } = routePartsFromSegments([second, first])
    expect(parts).toHaveLength(1)
    expectNoInventedSteps(parts, [first, second])
  })

  it('does not chain nearby ends into one junction wider than the snap distance', () => {
    // Three ends 0, 25 and 50 m apart. Chained snapping made one junction of
    // all three and drew the 50 m (on Rocky Oaks Loop, 68 m) between them.
    const at = (metres: number) => ({ lat: origin.lat, lng: origin.lng + (metres * M) / Math.cos((origin.lat * Math.PI) / 180) })
    const pieces = [0, 25, 50].map(offset => run(at(offset), 10, 1, 0).reverse())
    const { parts } = routePartsFromSegments(pieces)
    expectNoInventedSteps(parts, pieces)
  })

  it('joins a branch that meets the middle of another piece (T-junction)', () => {
    const main = run(origin, 41, 0, 1)
    const spur = run(main[20], 15, 1, 0).slice(1)
    spur.unshift({ lat: main[20].lat + 3 * M, lng: main[20].lng })
    const { parts, lengthMeters } = routePartsFromSegments([main, spur])
    expect(parts).toHaveLength(1)
    expectNoInventedSteps(parts, [main, spur])
    expect(lengthMeters).toBeCloseTo(lineLengthMeters(main) + lineLengthMeters(spur), 3)
    // The spur's tip is on the drawn line: it is walked out and back.
    expect(parts[0].map(key)).toContain(key(spur[spur.length - 1]))
  })

  it('walks a branching trail as one line with each branch out and back', () => {
    // A plus sign: four arms from one junction. No Euler path exists.
    const center = origin
    const arms = [run(center, 12, 1, 0), run(center, 12, -1, 0), run(center, 12, 0, 1), run(center, 12, 0, -1)]
    const { parts, lengthMeters } = routePartsFromSegments(arms)
    expect(parts).toHaveLength(1)
    expectNoInventedSteps(parts, arms)
    const tips = arms.map(arm => key(arm[arm.length - 1]))
    for (const tip of tips)
      expect(parts[0].map(key)).toContain(tip)
    expect(lengthMeters).toBeCloseTo(arms.reduce((sum, arm) => sum + lineLengthMeters(arm), 0), 3)
  })

  it('closes a loop split into shuffled pieces', () => {
    const north = run(origin, 11, 0, 1)
    const east = run(north[10], 11, 1, 0)
    const south = run(east[10], 11, 0, -1)
    const west = run(south[10], 11, -1, 0)
    const { parts } = routePartsFromSegments([south, west.reverse(), north, east])
    expect(parts).toHaveLength(1)
    const loop = parts[0]
    expect(haversineDistance(loop[0], loop[loop.length - 1])).toBeLessThan(1)
    expectNoInventedSteps(parts, [north, east, south, west])
  })

  it('counts a piece listed twice once', () => {
    const line = run(origin, 20, 1, 1)
    const { parts, lengthMeters } = routePartsFromSegments([line, [...line].reverse(), line])
    expect(parts).toHaveLength(1)
    expect(lengthMeters).toBeCloseTo(lineLengthMeters(line), 3)
  })

  it('ignores points that are not coordinates and pieces too short to draw', () => {
    const line = run(origin, 5, 1, 0)
    const { parts } = routePartsFromSegments([[line[0]], [...line, { lat: Number.NaN, lng: 0 }], []])
    expect(parts).toHaveLength(1)
    expect(parts[0]).toHaveLength(5)
    expect(routePartsFromSegments([]).parts).toEqual([])
  })
})

describe('stored route geometry', () => {
  it('writes one part in the historical flat form', () => {
    const stored = encodeRouteParts([[{ lat: 1.123456, lng: 2 }, { lat: 1.2, lng: 2.1 }]])
    expect(JSON.parse(stored)).toEqual([[1.12346, 2], [1.2, 2.1]])
  })

  it('writes several parts one array each, and reads both forms', () => {
    const a = [{ lat: 1, lng: 1 }, { lat: 1.01, lng: 1 }, { lat: 1.02, lng: 1 }]
    const b = [{ lat: 2, lng: 2 }, { lat: 2.001, lng: 2 }]
    const stored = encodeRouteParts([a, b])
    expect(decodeRouteParts(stored)).toEqual([[[1, 1], [1.01, 1], [1.02, 1]], [[2, 2], [2.001, 2]]])
    expect(decodeRouteParts('[[1,1],[2,2]]')).toEqual([[[1, 1], [2, 2]]])
    expect(decodeRouteParts([[1, 1], [2, 2]])).toEqual([[[1, 1], [2, 2]]])
  })

  it('reads the main part as the longest, never the parts joined', () => {
    const stored = JSON.stringify([[[2, 2], [2.001, 2]], [[1, 1], [1.01, 1], [1.02, 1]]])
    expect(primaryRoutePart(stored)).toEqual([[1, 1], [1.01, 1], [1.02, 1]])
    expect(parseTrailGeometry(stored)).toEqual([[1, 1], [1.01, 1], [1.02, 1]])
    expect(parseTrailGeometryParts(stored)).toHaveLength(2)
  })

  it('survives malformed geometry', () => {
    for (const bad of ['', 'nope', '{}', '[', null, undefined, 42, '[[1]]', '[["a","b"]]'])
      expect(decodeRouteParts(bad)).toEqual([])
    expect(primaryRoutePart('nope')).toEqual([])
  })

  it('shares the point budget across parts and keeps every part drawable', () => {
    const long = run({ lat: 34, lng: -118 }, 500, 1, 0)
    const short = run({ lat: 35, lng: -118 }, 40, 1, 0)
    const parts = decodeRouteParts(encodeRouteGeometry([long, short]))
    expect(parts).toHaveLength(2)
    expect(parts[0].length + parts[1].length).toBeLessThanOrEqual(152)
    expect(parts[1].length).toBeGreaterThanOrEqual(2)
  })

  it('hands the page the main line plus the parts of a multi-part trail', () => {
    const multi = JSON.stringify([[[34, -118], [34.001, -118], [34.002, -118]], [[34.01, -118], [34.011, -118]]])
    const { geometryById, routePartsById } = normalizeTrailsPayload({ trails: [
      { id: 1, latitude: 34, longitude: -118, geometry: multi },
      { id: 2, latitude: 34, longitude: -118, geometry: '[[34,-118],[34.001,-118]]' },
    ] })
    expect(geometryById[1]).toEqual([[34, -118], [34.001, -118], [34.002, -118]])
    expect(routePartsById[1]).toHaveLength(2)
    expect(geometryById[2]).toEqual([[34, -118], [34.001, -118]])
    expect(routePartsById[2]).toBeUndefined()
  })
})

describe('ArcGIS trail identity', () => {
  it('groups runs by proximity and orders clusters deterministically', () => {
    const a = run({ lat: 40, lng: -105 }, 10, 1, 0)
    const b = run(a[9], 10, 1, 0)
    const far = run({ lat: 39, lng: -105 }, 10, 1, 0)
    const clusters = clusterRuns([{ run: b, member: 'b' }, { run: far, member: 'far' }, { run: a, member: 'a' }])
    expect(clusters.map(c => c.members.sort())).toEqual([['far'], ['a', 'b']])
  })

  it('keeps a feature\'s disjoint paths apart instead of joining them', () => {
    const feature: EsriFeature<unknown> = {
      attributes: {},
      geometry: { paths: [[[-105, 40], [-105, 40.001]], [[-105, 40.005], [-105, 40.006]]] },
    }
    const [network] = featureRoutes([feature])
    expect(network.parts).toHaveLength(2)
    for (const part of network.parts)
      expect(maxStep(part)).toBeLessThan(120)
  })
})

describe('OSM elements', () => {
  it('assembles an out-of-order relation without drawing across its gaps', () => {
    const line = run({ lat: 47, lng: 11 }, 60, 1, 0.5)
    const members = [line.slice(40), line.slice(0, 21), line.slice(20, 41).reverse()]
      .map(member => ({ geometry: member.map(p => ({ lat: p.lat, lon: p.lng })) }))
    const route = elementRoute({ type: 'relation', id: 1, members })
    expect(route.parts).toHaveLength(1)
    expect(maxStep(route.parts[0])).toBeCloseTo(maxStep(line), 6)
    expect(route.lengthMeters).toBeCloseTo(lineLengthMeters(line), 3)
  })

  it('keeps a way exactly as mapped', () => {
    const line = run({ lat: 47, lng: 11 }, 8, -1, 1)
    const route = elementRoute({ type: 'way', id: 2, geometry: line.map(p => ({ lat: p.lat, lon: p.lng })) })
    expect(route.parts).toEqual([line])
  })
})

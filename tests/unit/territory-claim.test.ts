import type { Coordinate } from '../../resources/functions/geo'
import { describe, expect, it } from 'bun:test'
import {
  calculatePerimeter,
  calculatePolygonArea,
  distanceToRingMeters,
  isClosedLoop,
  pointInPolygon,
  polygonsOverlap,
  ringSelfIntersects,
  simplifyTrack,
} from '../../resources/functions/geo'
import { validateGpsDataForClaim, validateTrackRealism } from '../../resources/functions/gpx'

/**
 * The territory claim pipeline.
 *
 * This is the mechanic the product is built around — the thing a trail
 * database alone is not — and it had no tests at all. Every rule below is one
 * a claim depends on, and each of them is silently breakable: a track that
 * stops being recognised as a loop, an area calculation that drifts, or an
 * anti-cheat check that starts passing fabricated GPS would all leave the game
 * running and wrong.
 *
 * The bounds mirror ClaimTerritoryAction: 1,000 m² floor, 5,000,000 m² ceiling.
 */

const MIN_TERRITORY_SIZE = 1000
const MAX_TERRITORY_SIZE = 5_000_000

/** A plausible recorded loop: `points` samples a minute apart around a centre. */
function loop(centerLat: number, centerLng: number, radiusDeg: number, points = 60): Array<{ lat: number, lng: number, time: string }> {
  const track = []
  const start = Date.UTC(2026, 0, 1, 12, 0, 0)

  for (let i = 0; i < points; i++) {
    const angle = (i / (points - 1)) * 2 * Math.PI
    track.push({
      lat: Number((centerLat + radiusDeg * Math.sin(angle)).toFixed(6)),
      // Longitude is squeezed by latitude, so the shape stays a circle on the
      // ground rather than an ellipse.
      lng: Number((centerLng + radiusDeg * Math.cos(angle) * Math.cos(centerLat * Math.PI / 180)).toFixed(6)),
      time: new Date(start + i * 60_000).toISOString(),
    })
  }

  return track
}

function coordsOf(track: unknown): Coordinate[] {
  const result = validateGpsDataForClaim(JSON.stringify(track))
  expect(result.valid).toBe(true)
  return result.coordinates!
}

describe('territory claim: a valid loop', () => {
  const track = loop(39.7392, -105.2211, 0.005)

  it('parses, passes realism, and closes', () => {
    const result = validateGpsDataForClaim(JSON.stringify(track))
    expect(result.valid).toBe(true)
    expect(validateTrackRealism(result.coordinates!).valid).toBe(true)
    expect(isClosedLoop(result.coordinates!)).toBe(true)
  })

  it('produces an area inside the claimable bounds', () => {
    const simplified = simplifyTrack(coordsOf(track))
    const area = calculatePolygonArea(simplified)

    expect(simplified.length).toBeGreaterThan(3)
    expect(area).toBeGreaterThan(MIN_TERRITORY_SIZE)
    expect(area).toBeLessThan(MAX_TERRITORY_SIZE)
    // A ~1.1 km-wide loop is a few hundred thousand square metres. Pinning the
    // order of magnitude catches a unit slip (m² vs km²) that bounds alone
    // would not.
    expect(area).toBeGreaterThan(100_000)
    expect(calculatePerimeter(simplified)).toBeGreaterThan(1000)
  })

  it('simplifies without collapsing the shape', () => {
    const full = coordsOf(track)
    const simplified = simplifyTrack(full)
    const lost = Math.abs(calculatePolygonArea(full) - calculatePolygonArea(simplified))

    expect(simplified.length).toBeLessThanOrEqual(full.length)
    // Simplification is for storage, not for changing what was claimed.
    expect(lost / calculatePolygonArea(full)).toBeLessThan(0.05)
  })
})

describe('territory claim: what must be refused', () => {
  it('refuses a track that never returns to its start', () => {
    const open = coordsOf(loop(39.7392, -105.2211, 0.005)).slice(0, 40)
    expect(isClosedLoop(open)).toBe(false)
  })

  it('refuses a track that teleports', () => {
    const cheated = coordsOf(loop(39.7392, -105.2211, 0.005))
    // Five degrees of latitude between two samples a minute apart: ~550 km,
    // the signature of a stitched or fabricated track.
    cheated[30] = { ...cheated[30], lat: cheated[30].lat + 5 }

    expect(validateTrackRealism(cheated).valid).toBe(false)
  })

  it('refuses a loop too small to be worth land', () => {
    // ~11 m across — someone walking in a circle at their desk.
    const area = calculatePolygonArea(simplifyTrack(coordsOf(loop(39.7392, -105.2211, 0.00005))))
    expect(area).toBeLessThan(MIN_TERRITORY_SIZE)
  })

  it('refuses a track with too few points to be a real recording', () => {
    const sparse = loop(39.7392, -105.2211, 0.005, 5)
    expect(validateGpsDataForClaim(JSON.stringify(sparse)).valid).toBe(false)
  })

  it('refuses empty and malformed payloads', () => {
    expect(validateGpsDataForClaim('').valid).toBe(false)
    expect(validateGpsDataForClaim('[]').valid).toBe(false)
    expect(validateGpsDataForClaim('not json').valid).toBe(false)
  })
})

describe('territory claim: conquest overlap', () => {
  const defender = simplifyTrack(coordsOf(loop(39.7392, -105.2211, 0.005)))

  it('detects a loop drawn over existing land', () => {
    // Same centre, slightly wider — a rival running the same trail.
    const attacker = simplifyTrack(coordsOf(loop(39.7392, -105.2211, 0.006)))
    expect(polygonsOverlap(defender, attacker)).toBe(true)
  })

  it('leaves a loop somewhere else alone', () => {
    // ~50 km north. Two people running different trails must not fight.
    const elsewhere = simplifyTrack(coordsOf(loop(40.2000, -105.2211, 0.005)))
    expect(polygonsOverlap(defender, elsewhere)).toBe(false)
  })
})

describe('territory claim: loops that cross themselves', () => {
  const METRES_PER_DEG = 111_320
  const centre = { lat: 34.05, lng: -118.25 }
  const at = (north: number, east: number): Coordinate => ({
    lat: centre.lat + north / METRES_PER_DEG,
    lng: centre.lng + east / (METRES_PER_DEG * Math.cos(centre.lat * Math.PI / 180)),
  })
  /** A circle of `radius` metres around (north, east), one way round or the other. */
  const lap = (radius: number, north = 0, east = 0, clockwise = false, from = 0): Coordinate[] =>
    Array.from({ length: 61 }, (_, i) => {
      const angle = from + (clockwise ? -1 : 1) * (i / 60) * 2 * Math.PI
      return at(north + radius * Math.sin(angle), east + radius * Math.cos(angle))
    })
  const oneLap = lap(100)
  const oneLapArea = calculatePolygonArea(simplifyTrack(oneLap))

  it('measures a simple loop exactly as before', () => {
    expect(ringSelfIntersects(oneLap)).toBe(false)
    expect(oneLapArea).toBeGreaterThan(30_000)
    expect(oneLapArea).toBeLessThan(31_500)
  })

  it('counts the ground inside two laps once, not twice', () => {
    // Slightly different the second time round, as a second lap always is.
    const twoLaps = simplifyTrack([...oneLap, ...lap(98).slice(1)])
    expect(ringSelfIntersects(twoLaps)).toBe(true)
    expect(calculatePolygonArea(twoLaps) / oneLapArea).toBeCloseTo(1, 1)
  })

  it('counts both lobes of a figure of eight', () => {
    // Round the east field anticlockwise, back through the middle and round
    // the west field clockwise: the two lobes wind opposite ways.
    const eight = simplifyTrack([...lap(100, 0, 100, false, Math.PI), ...lap(100, 0, -100, true, 0).slice(1)])
    expect(calculatePolygonArea(eight) / (2 * oneLapArea)).toBeCloseTo(1, 1)
  })

  it('treats the middle of a two-lap loop as inside it', () => {
    const twoLaps = [...oneLap, ...lap(98).slice(1)]
    expect(pointInPolygon(centre, twoLaps)).toBe(true)
    expect(pointInPolygon(at(0, 300), twoLaps)).toBe(false)
  })
})

describe('territory claim: protected home zone', () => {
  it('measures to the outline between vertices, not only to the vertices', () => {
    // A 1 km straight edge, simplified to its two ends; home 100 m off its middle.
    const ring: Coordinate[] = [
      { lat: 34.0, lng: -118.0 },
      { lat: 34.0, lng: -117.98918 },
      { lat: 34.009, lng: -117.98918 },
      { lat: 34.009, lng: -118.0 },
    ]
    const home = { lat: 33.9991, lng: -117.99459 }
    expect(distanceToRingMeters(home, ring)).toBeGreaterThan(90)
    expect(distanceToRingMeters(home, ring)).toBeLessThan(110)
  })
})

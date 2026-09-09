/**
 * Shared normalization used by every trail source.
 *
 * The per-source adapters differ only in how they get their coordinates and
 * attributes; everything downstream of that — distance, bounds, difficulty,
 * pace estimate, storage-sized geometry — is the same maths and lives here so
 * the three sources cannot drift apart on it.
 */

import type { Coordinate } from '../../resources/functions/geo'
import type { TrailDifficulty, TrailRouteType } from './types'
import { haversineDistance } from '../../resources/functions/geo'
import { formatTrailTime } from '../../resources/functions/trail-time'

export const METERS_PER_MILE = 1609.344
export const FEET_PER_METER = 3.280_84

/** Points kept per trail. Enough to draw a recognisable line on a map. */
const MAX_GEOMETRY_POINTS = 150

/** Below this, a "trail" is a driveway or a mapping artifact, not a route. */
export const MIN_TRAIL_MILES = 0.1

export interface PathStats {
  distanceMiles: number
  centroid: Coordinate
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
  /** True when the path ends where it started — the only shape that can claim territory. */
  closed: boolean
}

/**
 * Distance, bounds, centroid and closure in one pass.
 *
 * Done together deliberately: these are computed for every one of millions of
 * features, and walking the coordinate array four times to get four numbers is
 * the difference between an ingest that finishes overnight and one that does not.
 */
export function pathStats(coords: Coordinate[]): PathStats {
  return segmentedPathStats([coords])
}

/**
 * The same statistics for a path that arrives in disconnected pieces.
 *
 * OSM route relations are a list of member ways, and those members are not
 * reliably ordered or contiguous — a route has alternates, spurs and plain
 * gaps. Concatenating them into one array and measuring end to end counts the
 * jump between every pair of members as trail: it recorded Zentralalpenweg 02,
 * a 1,300 km route, as 1,687 miles, and inflated 14,000 other relations the
 * same way.
 *
 * Distance is therefore summed WITHIN members and never across them, while
 * bounds, centroid and closure still consider every point. Closure is judged
 * on the first and last point of the whole set, which stays correct for a
 * genuine ring split across several ways.
 */
export function segmentedPathStats(segments: Coordinate[][]): PathStats {
  const coords = segments.length === 1 ? segments[0] : segments.flat()
  let meters = 0
  let sumLat = 0
  let sumLng = 0
  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  let minLng = Number.POSITIVE_INFINITY
  let maxLng = Number.NEGATIVE_INFINITY

  for (let i = 0; i < coords.length; i++) {
    const point = coords[i]

    sumLat += point.lat
    sumLng += point.lng

    if (point.lat < minLat)
      minLat = point.lat
    if (point.lat > maxLat)
      maxLat = point.lat
    if (point.lng < minLng)
      minLng = point.lng
    if (point.lng > maxLng)
      maxLng = point.lng

  }

  // Measured per member, so the gaps between them never count as trail.
  for (const segment of segments) {
    for (let i = 1; i < segment.length; i++)
      meters += haversineDistance(segment[i - 1], segment[i])
  }

  const first = coords[0]
  const last = coords[coords.length - 1]

  return {
    distanceMiles: round(meters / METERS_PER_MILE, 2),
    centroid: {
      lat: round(sumLat / coords.length, 6),
      lng: round(sumLng / coords.length, 6),
    },
    minLat: round(minLat, 6),
    maxLat: round(maxLat, 6),
    minLng: round(minLng, 6),
    maxLng: round(maxLng, 6),
    // 50 m of slop: GPS-traced and surveyed loops rarely close to the metre.
    closed: coords.length > 3 && haversineDistance(first, last) < 50,
  }
}

export function round(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(value * factor) / factor
}

/**
 * Reduce a path to at most `MAX_GEOMETRY_POINTS` while keeping its shape.
 *
 * Uniform sampling rather than Douglas-Peucker: at national scale this runs
 * tens of millions of times, the output is only ever drawn at map zoom, and
 * the endpoints (which decide whether a route reads as a loop) are preserved
 * explicitly.
 */
export function simplifyPath(coords: Coordinate[], maxPoints = MAX_GEOMETRY_POINTS): Coordinate[] {
  if (coords.length <= maxPoints)
    return coords

  const step = Math.ceil(coords.length / maxPoints)
  const out: Coordinate[] = []

  for (let i = 0; i < coords.length; i += step)
    out.push(coords[i])

  const last = coords[coords.length - 1]
  const tail = out[out.length - 1]
  if (!tail || tail.lat !== last.lat || tail.lng !== last.lng)
    out.push(last)

  return out
}

/** Storage form: `[[lat,lng],…]` at 5dp (~1 m), which the map layer reads directly. */
export function encodeGeometry(coords: Coordinate[]): string {
  return JSON.stringify(simplifyPath(coords).map(c => [round(c.lat, 5), round(c.lng, 5)]))
}

/**
 * Difficulty from effort rather than from whatever grade the source happens to
 * publish, so an OSM path and a Forest Service trail of the same shape land in
 * the same bucket.
 *
 * The thresholds follow the shape of Naismith-adjusted effort: distance sets
 * the floor, sustained climb per mile raises it.
 */
export function deriveDifficulty(distanceMiles: number, ascentFeet: number): TrailDifficulty {
  const feetPerMile = distanceMiles > 0 ? ascentFeet / distanceMiles : 0

  if (distanceMiles > 8 || ascentFeet > 2000 || feetPerMile > 600)
    return 'hard'
  if (distanceMiles > 3 || ascentFeet > 700 || feetPerMile > 300)
    return 'moderate'

  return 'easy'
}

/**
 * Route shape. `closed` is measured from the geometry; the rest is a judgement
 * call the sources cannot make for us, so an unclosed named path is reported as
 * out-and-back (how people actually walk a dead-end trail) and an unnamed
 * fragment of a larger web as `network`.
 */
export function deriveRouteType(closed: boolean, named: boolean): TrailRouteType {
  if (closed)
    return 'loop'
  if (!named)
    return 'network'
  return 'out-and-back'
}

/**
 * Naismith's rule with Tranter-style flattening: 3 mph on the level plus an
 * hour per 2000 ft of ascent. Formatted the way the UI shows it, which for a
 * thru-hike means days rather than the three-figure hour count the raw rule
 * produces (see resources/functions/trail-time).
 */
export function estimateTime(distanceMiles: number, ascentFeet: number): string {
  const hours = distanceMiles / 3 + ascentFeet / 2000
  return formatTrailTime(Math.max(5, Math.round(hours * 60)))
}

/**
 * Collapse the sources' surface vocabularies onto one small set. Anything
 * unrecognised becomes an empty string rather than a guess, so a filter on
 * `surface` never quietly lies.
 */
export function normalizeSurface(raw: string | null | undefined): string {
  if (!raw)
    return ''

  const value = raw.toLowerCase()

  if (/asphalt|concrete|paved|chipseal|bitumen/.test(value))
    return 'paved'
  if (/gravel|crushed|aggregate|cinder|pebble/.test(value))
    return 'gravel'
  if (/board|wood|plank|deck/.test(value))
    return 'boardwalk'
  if (/sand|beach/.test(value))
    return 'sand'
  if (/snow|ice/.test(value))
    return 'snow'
  if (/water/.test(value))
    return 'water'
  if (/rock|stone|scree|talus/.test(value))
    return 'rock'
  if (/grass|turf/.test(value))
    return 'grass'
  if (/dirt|native|ground|earth|soil|natural|mineral|compacted/.test(value))
    return 'dirt'

  return ''
}

/** Deduplicate and order a use list so the stored string is comparable. */
export function encodeUses(uses: Iterable<string>): string {
  return [...new Set([...uses].filter(Boolean))].sort().join(',')
}

/** Same, for the display tags the cards render. */
export function encodeTags(tags: Iterable<string>): string {
  return [...new Set([...tags].filter(Boolean))].join(',')
}

/**
 * Cover image.
 *
 * Neither the Forest Service nor the Park Service publishes photos through
 * these layers, and OSM almost never does, so rather than leave every card
 * blank the trail gets one of a small set of licensed landscape photographs,
 * picked deterministically from its source id. Deterministic matters: a re-sync
 * must not reshuffle every image in the catalog.
 */
const FALLBACK_IMAGES = [
  'https://images.unsplash.com/photo-1551632811-561732d1e306?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1454391304352-2bf4678b1a7a?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1465056836041-7f43ac27dcb5?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1476231682828-37e571bc172f?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1533240332313-0db49b459ad6?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?w=800&h=600&fit=crop',
]

export function pickImage(sourceId: string): string {
  let hash = 0
  for (let i = 0; i < sourceId.length; i++)
    hash = (hash * 31 + sourceId.charCodeAt(i)) >>> 0

  return FALLBACK_IMAGES[hash % FALLBACK_IMAGES.length]
}

export function metersToFeet(meters: number): number {
  return Math.round(meters * FEET_PER_METER)
}

/** Countries whose readers expect miles rather than kilometres. */
const IMPERIAL_COUNTRIES = new Set(['US'])

/**
 * A trail's length written the way a reader in that country expects.
 *
 * Every column stays in miles and feet — one storage unit keeps sorting,
 * filtering and the difficulty thresholds coherent across the whole catalog.
 * This is only for prose: "a 4.8-kilometre trail in Tirol" rather than "a
 * 3-mile trail in Tirol", which reads as though the data were imported from
 * somewhere it does not belong.
 */
export function describeDistance(distanceMiles: number, country: string): string {
  if (IMPERIAL_COUNTRIES.has(country))
    return `${distanceMiles}-mile`

  const km = round(distanceMiles * (METERS_PER_MILE / 1000), 1)
  return `${km}-kilometre`
}

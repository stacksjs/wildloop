/**
 * OpenStreetMap, via the Overpass API.
 *
 * The broadest of the three sources by a wide margin: OSM has the city
 * greenway, the county park loop and the unsigned singletrack that no federal
 * dataset carries. It is also the only one that is not US-only — the Forest
 * Service and Park Service have no German, Austrian or Swiss equivalent, so
 * outside the US this is the whole catalog.
 *
 * It has no primary key we can page through, so coverage is achieved
 * geographically: each covered area is cut into one-degree tiles and each tile
 * is one unit of retryable work.
 *
 * Licence: ODbL. Attribution is carried on every row via `sourceUrl`.
 */

import type { Coordinate } from '../../../resources/functions/geo'
import type { NormalizedTrail, Shard, SourceFetchResult, TrailSourceAdapter } from '../types'
import { TrailHttpClient } from '../client'
import {
  deriveDifficulty,
  describeDistance,
  deriveRouteType,
  encodeGeometry,
  encodeTags,
  encodeUses,
  estimateTime,
  metersToFeet,
  MIN_TRAIL_MILES,
  normalizeSurface,
  segmentedPathStats,
  pickImage,
} from '../normalize'
import { resolveRegion } from '../regions'

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter'

/**
 * Tile size in degrees.
 *
 * One degree is the largest tile Overpass reliably answers for this query in
 * dense terrain; larger tiles time out around metropolitan areas, and smaller
 * ones multiply a 1,200-request run into an unnecessarily long one.
 */
const TILE_DEGREES = 1

/**
 * Every area the OSM ingest sweeps. Tiles that fall in no covered region are
 * dropped, so these can be generous rectangles rather than tight outlines.
 *
 * The DACH box is a single rectangle because the three countries are
 * contiguous and small enough that separate boxes would overlap anyway; the
 * per-tile land check discards what falls in France, Italy or the Czech
 * Republic. It is ~90 tiles against the US's ~1,370.
 */
const COVERAGE_BOXES: Array<[number, number, number, number]> = [
  // [south, west, north, east]
  [24, -125, 50, -66], // CONUS
  [51, -180, 72, -129], // Alaska
  [18, -161, 23, -154], // Hawaii
  [45, 5, 56, 18], // Germany, Austria, Switzerland
]

interface OverpassElement {
  type: 'way' | 'relation' | 'node'
  id: number
  tags?: Record<string, string>
  geometry?: Array<{ lat: number, lon: number }>
  members?: Array<{ geometry?: Array<{ lat: number, lon: number }> }>
}

interface OverpassResponse {
  elements?: OverpassElement[]
  remark?: string
}

/**
 * Overpass is a shared free service with a documented "be gentle" policy, so
 * this is deliberately slow: two requests a minute and long timeouts.
 *
 * The cache TTL only applies when `TRAIL_INGEST_CACHE=1` (see client.ts). Be
 * careful turning it on for this source in particular: a dense tile answers
 * with tens of megabytes and there are ~1,400 of them.
 */
const client = new TrailHttpClient({
  name: 'overpass',
  rateLimit: { requestsPerMinute: 2, burstSize: 1 },
  timeout: 300_000,
  cacheTtl: 7 * 24 * 3600,
  retry: {
    maxRetries: 4,
    initialDelay: 30_000,
    maxDelay: 300_000,
    backoffMultiplier: 2,
    jitter: true,
    // 400 means our query is wrong and will stay wrong; only back off on the
    // codes Overpass uses for "busy" (429) and "took too long" (504).
    retryOn: [429, 500, 502, 503, 504],
  },
})

/**
 * What counts as a trail.
 *
 * `footway` is filtered to exclude sidewalks and crossings — without that,
 * every city block in the country arrives as a "trail". `track` is limited to
 * grades 1-3, which excludes rutted logging spurs. Route relations pick up the
 * long-distance trails whose ways are individually unnamed.
 */
function buildQuery(south: number, west: number, north: number, east: number): string {
  const bbox = `${south},${west},${north},${east}`

  return [
    `[out:json][timeout:280][bbox:${bbox}];`,
    '(',
    'way["highway"="path"]["name"];',
    'way["highway"="footway"]["name"]["footway"!~"sidewalk|crossing"];',
    'way["highway"="bridleway"]["name"];',
    'way["highway"="track"]["name"]["tracktype"~"^grade[1-3]$"];',
    'relation["route"~"^(hiking|foot)$"]["name"];',
    ');',
    'out body geom;',
  ].join('')
}

/**
 * A way yields one segment; a relation yields one per member way.
 *
 * The boundaries matter — see `segmentedPathStats`. Flattening them here made
 * the jump from the end of one member to the start of the next count as trail.
 */
function extractSegments(element: OverpassElement): Coordinate[][] {
  if (element.geometry)
    return [element.geometry.map(point => ({ lat: point.lat, lng: point.lon }))]

  if (element.members) {
    return element.members
      .filter(member => member.geometry && member.geometry.length > 0)
      .map(member => member.geometry!.map(point => ({ lat: point.lat, lng: point.lon })))
  }

  return []
}

function extractName(tags: Record<string, string>): string | null {
  return tags.name || tags['name:en'] || (tags.ref ? `${tags.ref} Trail` : null)
}

/**
 * OSM records ascent only on route relations, and even then rarely. When it is
 * absent the value is 0 rather than an estimate — a fabricated climb would
 * feed straight into difficulty and pace and make both untrustworthy.
 */
function parseAscentFeet(tags: Record<string, string>): number {
  const raw = tags.ascent ?? tags['ascent:total']
  if (!raw)
    return 0

  const meters = Number.parseFloat(raw.replace(/[^0-9.]/g, ''))
  return Number.isFinite(meters) ? metersToFeet(meters) : 0
}

function parseElevationHighFeet(tags: Record<string, string>): number {
  const raw = tags['ele:max'] ?? tags.ele
  if (!raw)
    return 0

  const meters = Number.parseFloat(raw.replace(/[^0-9.-]/g, ''))
  return Number.isFinite(meters) ? metersToFeet(meters) : 0
}

/**
 * OSM's `dog` tag, read as yes, no, or not recorded.
 *
 * Most ways carry no `dog` tag at all. Reading that as "no" put a "No dogs"
 * notice on nearly every OSM trail.
 */
export function dogPolicy(tag: string | undefined): boolean | null {
  if (tag === 'yes' || tag === 'leashed' || tag === 'designated')
    return true
  if (tag === 'no')
    return false
  return null
}

function deriveUses(tags: Record<string, string>): string {
  const uses = new Set<string>(['hiking'])

  if (tags.highway === 'path' || tags.highway === 'footway')
    uses.add('running')
  if (tags.bicycle === 'yes' || tags.bicycle === 'designated' || tags.highway === 'cycleway')
    uses.add('bike')
  if (tags.horse === 'yes' || tags.horse === 'designated' || tags.highway === 'bridleway')
    uses.add('horse')
  if (tags.ski === 'yes' || tags.piste === 'yes')
    uses.add('ski')
  if (tags.motor_vehicle === 'yes' || tags.atv === 'yes')
    uses.add('atv')

  return encodeUses(uses)
}

function deriveDisplayTags(tags: Record<string, string>, surface: string, closed: boolean): string {
  const display = new Set<string>()

  if (surface)
    display.add(surface)
  if (closed)
    display.add('loop')
  if (tags.dog === 'yes' || tags.dog === 'leashed')
    display.add('dog-friendly')
  if (tags.wheelchair === 'yes')
    display.add('accessible')
  if (tags.lit === 'yes')
    display.add('lit')
  if (tags.natural === 'water' || tags.waterway)
    display.add('waterfall')
  if (/wood|forest/.test(tags.landuse ?? '') || tags.leaf_type)
    display.add('forest')
  if (tags.sac_scale && tags.sac_scale !== 'hiking')
    display.add('summit')
  if (tags.route === 'hiking' || tags.route === 'foot')
    display.add('hiking')

  return encodeTags(display)
}

function normalizeElement(element: OverpassElement): NormalizedTrail | null {
  const tags = element.tags ?? {}

  const name = extractName(tags)
  if (!name)
    return null

  const segments = extractSegments(element)
  // The drawn line stays the full point set; only the measurement is per
  // member, so a relation still renders as one route on the map.
  const coords = segments.flat()
  if (coords.length < 2)
    return null

  const stats = segmentedPathStats(segments)
  if (stats.distanceMiles < MIN_TRAIL_MILES)
    return null

  // A trail whose centroid resolves to no region is outside every country the
  // catalog covers, or in open water — a tile inevitably straddles both. This
  // is what keeps French and Italian trails out of the DACH sweep.
  const state = resolveRegion(stats.centroid.lat, stats.centroid.lng)
  if (!state)
    return null

  const ascent = parseAscentFeet(tags)
  const surface = normalizeSurface(tags.surface ?? tags.tracktype)
  const sourceId = `${element.type}/${element.id}`

  return {
    source: 'osm',
    sourceId,
    sourceUrl: `https://www.openstreetmap.org/${element.type}/${element.id}`,

    name,
    location: `${state.name}`,
    description: tags.description
      ?? `${name} is a ${describeDistance(stats.distanceMiles, state.country)} ${deriveDifficulty(stats.distanceMiles, ascent)} trail in ${state.name}. Mapped by the OpenStreetMap community.`,

    latitude: stats.centroid.lat,
    longitude: stats.centroid.lng,
    minLat: stats.minLat,
    maxLat: stats.maxLat,
    minLng: stats.minLng,
    maxLng: stats.maxLng,
    country: state.country,
    state: state.code,
    stateName: state.name,
    managedBy: tags.operator ?? '',

    distance: stats.distanceMiles,
    elevation: ascent,
    elevationHigh: parseElevationHighFeet(tags),
    difficulty: deriveDifficulty(stats.distanceMiles, ascent),
    routeType: deriveRouteType(stats.closed, true),
    surface,
    estimatedTime: estimateTime(stats.distanceMiles, ascent),
    geometry: encodeGeometry(coords),

    allowedUses: deriveUses(tags),
    dogsAllowed: dogPolicy(tags.dog),
    wheelchairAccessible: tags.wheelchair === 'yes',
    nationalTrail: tags.network === 'nwn' || tags.network === 'iwn',

    image: pickImage(sourceId),
    tags: deriveDisplayTags(tags, surface, stats.closed),
  }
}

export const osmSource: TrailSourceAdapter = {
  source: 'osm',

  shards(): Shard[] {
    const shards: Shard[] = []

    for (const [south, west, north, east] of COVERAGE_BOXES) {
      for (let lat = south; lat < north; lat += TILE_DEGREES) {
        for (let lng = west; lng < east; lng += TILE_DEGREES) {
          const tile = {
            south: lat,
            west: lng,
            north: Math.min(lat + TILE_DEGREES, north),
            east: Math.min(lng + TILE_DEGREES, east),
          }

          // Skip open ocean. A tile is kept when any of its corners or its
          // centre falls in a state, which keeps every coastal tile while
          // dropping roughly a third of the grid that contains no US land.
          if (!tileTouchesLand(tile))
            continue

          shards.push({
            source: 'osm',
            key: `osm:${tile.south.toFixed(0)},${tile.west.toFixed(0)}`,
            cursor: tile,
          })
        }
      }
    }

    return shards
  },

  async fetch(shard: Shard): Promise<SourceFetchResult> {
    const { south, west, north, east } = shard.cursor as Record<string, number>
    const query = buildQuery(south, west, north, east)

    const response = await client.json<OverpassResponse>(OVERPASS_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `data=${encodeURIComponent(query)}`,
      // Every Overpass request is a POST to the same URL, so the tile has to
      // be the cache key or the first tile's response would answer for all.
      cacheKey: shard.key,
    })

    // Overpass reports server-side timeouts in a `remark` with HTTP 200. Left
    // unchecked, that silently records a dense tile as "0 trails, done".
    if (response.remark && /timed out|out of memory/i.test(response.remark))
      throw new Error(`Overpass: ${response.remark}`)

    const elements = response.elements ?? []
    const trails: NormalizedTrail[] = []

    for (const element of elements) {
      const trail = normalizeElement(element)
      if (trail)
        trails.push(trail)
    }

    return { trails, seen: elements.length }
  },
}

/**
 * Re-fetch specific relations by id, outside the tile grid.
 *
 * Needed to repair rows written before member boundaries were preserved (see
 * `segmentedPathStats`): their distances were measured across the gaps between
 * a relation's member ways. The stored geometry is flattened, so the true
 * length cannot be recovered locally — the members have to come back from
 * Overpass.
 *
 * Fetching by id rather than re-running the tiles is what makes the repair
 * affordable: ~95 requests for 14,000 relations, against 1,459 tiles for a
 * full re-sync that would also redo 230,000 ways that were never wrong.
 *
 * Rate limiting, retries and the User-Agent come from the shared client, so
 * this is exactly as polite to Overpass as the normal ingest.
 */
export async function fetchRelationsByIds(ids: number[]): Promise<SourceFetchResult> {
  if (ids.length === 0)
    return { trails: [], seen: 0 }

  const query = `[out:json][timeout:280];relation(id:${ids.join(',')});out body geom;`

  const response = await client.json<OverpassResponse>(OVERPASS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `data=${encodeURIComponent(query)}`,
    cacheKey: `relations:${ids[0]}:${ids.length}`,
  })

  if (response.remark && /timed out|out of memory/i.test(response.remark))
    throw new Error(`Overpass: ${response.remark}`)

  const elements = response.elements ?? []
  const trails: NormalizedTrail[] = []

  for (const element of elements) {
    const trail = normalizeElement(element)
    if (trail)
      trails.push(trail)
  }

  return { trails, seen: elements.length }
}

function tileTouchesLand(tile: { south: number, west: number, north: number, east: number }): boolean {
  const midLat = (tile.south + tile.north) / 2
  const midLng = (tile.west + tile.east) / 2

  const probes: Array<[number, number]> = [
    [tile.south, tile.west],
    [tile.south, tile.east],
    [tile.north, tile.west],
    [tile.north, tile.east],
    [midLat, midLng],
    [midLat, tile.west],
    [midLat, tile.east],
    [tile.south, midLng],
    [tile.north, midLng],
  ]

  return probes.some(([lat, lng]) => resolveRegion(lat, lng) !== null)
}

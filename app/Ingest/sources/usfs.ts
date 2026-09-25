/**
 * USDA Forest Service — National Forest System Trails (EDW).
 *
 * ~86,000 segment rows covering every trail on national forest land, which is
 * where most of the backcountry mileage in the western US actually is. Public
 * domain, and richer than OSM on the things a hiker cares about: who may use
 * the trail, what the tread is, whether it is part of a National Scenic Trail.
 *
 * Sharded by administrative forest rather than by result offset, so all of a
 * trail's segments land in the same unit of work and can be joined into one
 * route before they are written.
 */

import type { RouteNetwork } from '../../../resources/functions/trail-geometry'
import type { NormalizedTrail, Shard, SourceFetchResult, TrailSourceAdapter } from '../types'
import type { EsriFeature } from './arcgis'
import { TrailHttpClient } from '../client'
import {
  deriveDifficulty,
  deriveRouteType,
  encodeRouteGeometry,
  encodeTags,
  encodeUses,
  estimateTime,
  MIN_TRAIL_MILES,
  normalizeSurface,
  networkStats,
  pickImage,
} from '../normalize'
import { resolveRegion } from '../regions'
import { featureRoutes, fetchAllPages } from './arcgis'

const TRAILS_LAYER = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_TrailNFSPublish_01/MapServer/0'
const FORESTS_LAYER = 'https://apps.fs.usda.gov/arcx/rest/services/EDW/EDW_ForestSystemBoundaries_01/MapServer/0'

interface TrailAttributes {
  trail_name: string | null
  trail_cn: string | null
  trail_no: string | null
  admin_org: string | null
  trail_surface: string | null
  trail_class: string | null
  typical_trail_grade: string | null
  accessibility_status: string | null
  national_trail_designation: number | null
  gis_miles: number | null
  hiker_pedestrian_managed: string | null
  hiker_pedestrian_accpt: string | null
  hiker_pedestrian_restricted: string | null
  bicycle_managed: string | null
  bicycle_accpt: string | null
  pack_saddle_managed: string | null
  pack_saddle_accpt: string | null
  atv_managed: string | null
  motorcycle_managed: string | null
  snowmobile_managed: string | null
  xcountry_ski_managed: string | null
}

interface ForestAttributes {
  forestorgcode: string | null
  forestname: string | null
}

const OUT_FIELDS: Array<keyof TrailAttributes> = [
  'trail_name',
  'trail_cn',
  'trail_no',
  'admin_org',
  'trail_surface',
  'trail_class',
  'typical_trail_grade',
  'accessibility_status',
  'national_trail_designation',
  'gis_miles',
  'hiker_pedestrian_managed',
  'hiker_pedestrian_accpt',
  'hiker_pedestrian_restricted',
  'bicycle_managed',
  'bicycle_accpt',
  'pack_saddle_managed',
  'pack_saddle_accpt',
  'atv_managed',
  'motorcycle_managed',
  'snowmobile_managed',
  'xcountry_ski_managed',
]

/**
 * The EDW server is a government box that is slow but not fragile. One request
 * per second is well within what it serves comfortably, and a day of caching
 * covers a whole ingest pass without re-asking.
 */
const client = new TrailHttpClient({
  name: 'usfs',
  rateLimit: { requestsPerSecond: 1, burstSize: 2 },
  timeout: 120_000,
  cacheTtl: 24 * 3600,
})

/** forestorgcode → forest name, filled once per process at shard enumeration. */
const forestNames = new Map<string, string>()

/**
 * Trail class 1-5 is the Forest Service's development scale, not a difficulty
 * scale, but it correlates well enough at the ends to be worth using as a
 * floor: a class 1 "minimally developed" trail is never genuinely easy, and a
 * class 5 "fully developed" one is never hard.
 */
function difficultyFloor(trailClass: string | null): 'easy' | 'moderate' | 'hard' | null {
  switch ((trailClass ?? '').trim()) {
    case '1': return 'hard'
    case '2': return 'moderate'
    case '5': return 'easy'
    default: return null
  }
}

const DIFFICULTY_ORDER = { easy: 0, moderate: 1, hard: 2 } as const

/**
 * The `*_managed` and `*_accpt` columns are **season strings**, not booleans:
 * a bike-legal trail reads `06/15-09/30` and a year-round one `01/01-12/31`.
 * A truthiness test that expected `Y`/`N` marked every trail in the country as
 * foot-only. Presence of a season is the signal; its contents are the season.
 */
function allowsUse(...seasons: Array<string | null | undefined>): boolean {
  return seasons.some(season => typeof season === 'string' && season.trim().length > 0)
}

function deriveUses(attributes: TrailAttributes): string {
  const uses = new Set<string>()

  // Foot travel is the default on National Forest System trails: it is
  // permitted unless a closure order says otherwise, and the layer records
  // that in `hiker_pedestrian_restricted`. The `managed`/`accpt` columns say
  // whether the trail is *maintained* for hikers, which is a different
  // question — reading them as permission left 294 of Flathead's 475 trails
  // tagged horse-only, none of them walkable.
  if (!allowsUse(attributes.hiker_pedestrian_restricted)) {
    uses.add('hiking')
    uses.add('running')
  }

  if (allowsUse(attributes.bicycle_managed, attributes.bicycle_accpt))
    uses.add('bike')
  if (allowsUse(attributes.pack_saddle_managed, attributes.pack_saddle_accpt))
    uses.add('horse')
  if (allowsUse(attributes.atv_managed))
    uses.add('atv')
  if (allowsUse(attributes.motorcycle_managed))
    uses.add('motorcycle')
  if (allowsUse(attributes.snowmobile_managed))
    uses.add('snowmobile')
  if (allowsUse(attributes.xcountry_ski_managed))
    uses.add('ski')

  return encodeUses(uses)
}

/**
 * The identity that decides which segments are one trail.
 *
 * Keyed on the FULL `admin_org` — the ranger district — not the four-digit
 * forest prefix. Trail numbers are only unique within a district: number 7 in
 * the Idaho Panhandle is `STATE LINE` in district 010401, `HEART LAKE` in
 * 010402 and `PYRAMID` in 010407. Keying on the forest merged all three into a
 * single 260-mile trail spanning two degrees of latitude.
 *
 * The name is part of the key too, so a district that genuinely reuses a
 * number still separates the trails.
 */
function trailKey(attributes: TrailAttributes): string | null {
  const district = attributes.admin_org?.trim()
  const number = attributes.trail_no?.trim()
  const name = attributes.trail_name?.trim()

  if (!name || !district)
    return null

  return `${district}|${number ?? ''}|${name.toUpperCase()}`
}

export const usfsSource: TrailSourceAdapter = {
  source: 'usfs',

  async shards(): Promise<Shard[]> {
    const forests = await fetchAllPages<ForestAttributes>(client, {
      endpoint: FORESTS_LAYER,
      where: '1=1',
      outFields: ['forestorgcode', 'forestname'],
      returnGeometry: false,
      orderByFields: 'forestorgcode',
    })

    const shards: Shard[] = []

    for (const forest of forests) {
      const code = forest.attributes.forestorgcode?.trim()
      if (!code)
        continue

      if (forest.attributes.forestname)
        forestNames.set(code, forest.attributes.forestname)

      shards.push({
        source: 'usfs',
        key: `usfs:${code}`,
        cursor: { forest: code },
      })
    }

    return shards
  },

  async fetch(shard: Shard): Promise<SourceFetchResult> {
    const forest = String(shard.cursor.forest)

    const features = await fetchAllPages<TrailAttributes>(client, {
      endpoint: TRAILS_LAYER,
      // admin_org is the district code; its first four digits are the forest.
      where: `admin_org LIKE '${forest}%'`,
      outFields: OUT_FIELDS as string[],
      orderByFields: 'trail_cn',
    })

    const grouped = new Map<string, Array<EsriFeature<TrailAttributes>>>()

    for (const feature of features) {
      const key = trailKey(feature.attributes)
      if (!key)
        continue

      const bucket = grouped.get(key)
      if (bucket)
        bucket.push(feature)
      else
        grouped.set(key, [feature])
    }

    const trails: NormalizedTrail[] = []

    for (const [key, segments] of grouped) {
      // One group can still yield several trails: where segments sharing an
      // identifier are not physically connected, they are separate paths on
      // the ground and are published as separate trails rather than joined
      // across the gap.
      const routes = featureRoutes(segments)

      routes.forEach((network, index) => {
        const suffix = routes.length > 1 ? `#${index + 1}` : ''
        const trail = normalizeTrail(`${key}${suffix}`, segments, forest, network)
        if (trail)
          trails.push(trail)
      })
    }

    return { trails, seen: features.length }
  },
}

function normalizeTrail(
  key: string,
  segments: Array<EsriFeature<TrailAttributes>>,
  forest: string,
  network: RouteNetwork,
): NormalizedTrail | null {
  if (network.parts.length === 0)
    return null

  const stats = networkStats(network)
  if (stats.distanceMiles < MIN_TRAIL_MILES)
    return null

  const state = resolveRegion(stats.centroid.lat, stats.centroid.lng, ['US'])
  if (!state)
    return null

  // The richest segment stands in for the trail: attributes are recorded per
  // segment and are frequently blank on the short connector pieces.
  const primary = segments.reduce((best, candidate) =>
    scoreAttributes(candidate.attributes) > scoreAttributes(best.attributes) ? candidate : best,
  ).attributes

  const name = primary.trail_name?.trim()
  if (!name)
    return null

  const forestName = forestNames.get(forest) ?? 'National Forest System'

  // EDW publishes no elevation on this layer. Reporting 0 keeps the number
  // honest; difficulty then falls back to distance and trail class alone.
  const ascent = 0
  const surface = normalizeSurface(primary.trail_surface)

  let difficulty = deriveDifficulty(stats.distanceMiles, ascent)
  const floor = difficultyFloor(primary.trail_class)
  if (floor && DIFFICULTY_ORDER[floor] > DIFFICULTY_ORDER[difficulty])
    difficulty = floor

  const sourceId = `usfs/${key}`

  // EDW publishes no domain for this column, but the distribution and the
  // names settle it: 1 covers 76,598 of 86,303 rows and is the "no
  // designation" default, 2 is National Recreation Trail (`ART LOEB NRT`,
  // `BARTRAM NRT`), 3 is National Scenic/Historic (`PACIFIC CREST`,
  // `APPALACHIAN`, `ARIZONA TRAIL`), 0 is unrecorded. Treating `> 0` as
  // designated would have flagged nine trails in ten as a National Trail.
  const nationalTrail = (primary.national_trail_designation ?? 0) >= 2
  const accessible = /accessible/i.test(primary.accessibility_status ?? '')

  const displayTags = new Set<string>(['forest'])
  if (surface)
    displayTags.add(surface)
  if (stats.closed)
    displayTags.add('loop')
  if (nationalTrail)
    displayTags.add('national-trail')
  if (accessible)
    displayTags.add('accessible')

  return {
    source: 'usfs',
    sourceId,
    sourceUrl: 'https://data.fs.usda.gov/geodata/edw/datasets.php',

    name: titleCase(name),
    location: `${forestName}, ${state.code}`,
    description: `${titleCase(name)} is a ${stats.distanceMiles}-mile ${difficulty} trail in ${forestName}, ${state.name}${primary.trail_no ? ` (Trail ${primary.trail_no.trim()})` : ''}.`,

    latitude: stats.centroid.lat,
    longitude: stats.centroid.lng,
    minLat: stats.minLat,
    maxLat: stats.maxLat,
    minLng: stats.minLng,
    maxLng: stats.maxLng,
    country: state.country,
    state: state.code,
    stateName: state.name,
    managedBy: forestName,

    distance: stats.distanceMiles,
    elevation: ascent,
    elevationHigh: 0,
    difficulty,
    routeType: deriveRouteType(stats.closed, true),
    surface,
    estimatedTime: estimateTime(stats.distanceMiles, ascent),
    geometry: encodeRouteGeometry(network.parts),

    allowedUses: deriveUses(primary),
    // National forests allow leashed dogs on trails as a rule; the layer has
    // no per-trail field to say otherwise.
    // No per-trail pet field in this layer either. A blanket true gave every
    // Forest Service trail a "Dog-friendly" badge.
    dogsAllowed: null,
    wheelchairAccessible: accessible,
    nationalTrail,

    image: pickImage(sourceId),
    tags: encodeTags(displayTags),
  }
}

/** How much a segment's attribute row actually says. Blanks score nothing. */
function scoreAttributes(attributes: TrailAttributes): number {
  let score = 0
  if (attributes.trail_name)
    score += 2
  if (attributes.trail_surface)
    score++
  if (attributes.trail_class)
    score++
  if (attributes.accessibility_status)
    score++
  if (attributes.national_trail_designation)
    score++
  return score
}

/**
 * Acronyms EDW writes unspaced, which title-casing turns into nonsense words.
 * `CDNST` became "Cdnst" on a 241-mile trail that is in fact the Continental
 * Divide National Scenic Trail, which is not a name anyone would recognise or
 * search for.
 */
const EXPANSIONS: Array<[RegExp, string]> = [
  [/\bCdnst\b/g, 'Continental Divide NST'],
  [/\bAnst\b/g, 'Appalachian NST'],
  [/\bPcnst\b/g, 'Pacific Crest NST'],
  [/\bAzt\b/g, 'Arizona NST'],
  [/\bNst\b/g, 'NST'],
  [/\bNrt\b/g, 'NRT'],
  [/\bNht\b/g, 'NHT'],
]

/** Uppercase runs that are initialisms rather than words. */
const KEEP_UPPER = /\b(Ohv|Atv|Nf|Ns|Us|Cg|Tr|Mtn|Jr|Sr|Ii|Iii|Iv|Cc|Ck|Mt|Rd)\b/g

/** EDW stores names in caps (`DREW CANYON`), which reads as shouting in the UI. */
function titleCase(value: string): string {
  let out = value
    .toLowerCase()
    .replace(/\b[a-z]/g, character => character.toUpperCase())

  for (const [pattern, replacement] of EXPANSIONS)
    out = out.replace(pattern, replacement)

  return out.replace(KEEP_UPPER, match => match.toUpperCase())
}

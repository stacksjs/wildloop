/**
 * National Park Service — public trails.
 *
 * ~31,000 segment rows across 350-odd park units. Smaller than the other two
 * sources but disproportionately valuable: these are the trails people
 * actually search for, and the layer carries the park name, the trail's use
 * profile and its accessibility status directly.
 *
 * Only features flagged for public display are read — the layer also carries
 * administrative and restricted routes that are not meant to be advertised.
 *
 * Sharded by park unit for the same reason USFS is sharded by forest: a named
 * trail is many segment rows, and they have to be grouped before they are
 * written.
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

const TRAILS_LAYER = 'https://mapservices.nps.gov/arcgis/rest/services/NationalDatasets/NPS_Public_Trails_Geographic/FeatureServer/0'

/**
 * Public and not known to be gone.
 *
 * `PUBLICDISPLAY` is the NPS's own "safe to show on a map" flag. `ISEXTANT` is
 * excluded rather than required: the field is free text across seven values
 * (`True`, `Yes`, `1`, `Partial`, `Unknown`, `False`, `2`), and demanding
 * `= 'True'` drops a third of the layer — every Acadia trail, for one, is
 * recorded as `Unknown`. Excluding only the two values that positively mean
 * "no longer there" keeps 30,990 of 31,358 rows instead of 21,361.
 */
const PUBLIC_FILTER = "PUBLICDISPLAY = 'Public Map Display' AND ISEXTANT NOT IN ('False', '2')"

interface TrailAttributes {
  TRLNAME: string | null
  MAPLABEL: string | null
  TRLALTNAME: string | null
  TRLSURFACE: string | null
  TRLTYPE: string | null
  TRLCLASS: string | null
  TRLUSE: string | null
  TRLSTATUS: string | null
  UNITCODE: string | null
  UNITNAME: string | null
  ACCESSNOTES: string | null
  SEASONAL: string | null
  GEOMETRYID: string | null
  MAINTAINER: string | null
  NOTES: string | null
}

interface UnitAttributes {
  UNITCODE: string | null
  UNITNAME: string | null
}

const OUT_FIELDS: Array<keyof TrailAttributes> = [
  'TRLNAME',
  'MAPLABEL',
  'TRLALTNAME',
  'TRLSURFACE',
  'TRLTYPE',
  'TRLCLASS',
  'TRLUSE',
  'TRLSTATUS',
  'UNITCODE',
  'UNITNAME',
  'ACCESSNOTES',
  'SEASONAL',
  'GEOMETRYID',
  'MAINTAINER',
  'NOTES',
]

const client = new TrailHttpClient({
  name: 'nps',
  rateLimit: { requestsPerSecond: 1, burstSize: 2 },
  timeout: 120_000,
  cacheTtl: 24 * 3600,
})

/**
 * `TRLUSE` is a free-text, often multi-valued field (`Hiking, Horse`), so it is
 * matched rather than mapped. `TRLTYPE` fills in for the water and snow routes
 * that carry no use string at all.
 */
function deriveUses(attributes: TrailAttributes): string {
  const uses = new Set<string>()
  const haystack = `${attributes.TRLUSE ?? ''} ${attributes.TRLTYPE ?? ''}`.toLowerCase()

  if (/hik|foot|pedestrian|walk/.test(haystack)) {
    uses.add('hiking')
    uses.add('running')
  }
  if (/bike|bicycl|cycl/.test(haystack))
    uses.add('bike')
  if (/horse|equestrian|stock|pack/.test(haystack))
    uses.add('horse')
  if (/ski|snowshoe/.test(haystack))
    uses.add('ski')
  if (/snowmobile/.test(haystack))
    uses.add('snowmobile')
  if (/atv|ohv|motor/.test(haystack))
    uses.add('atv')
  if (/water|paddl|canoe|kayak/.test(haystack))
    uses.add('paddling')

  if (uses.size === 0) {
    uses.add('hiking')
    uses.add('running')
  }

  return encodeUses(uses)
}

/**
 * The trail's name.
 *
 * `TRLNAME` is the documented field but is null on most of the layer — every
 * one of Acadia's 860 segments has it blank, with the name living in
 * `MAPLABEL` (the text the NPS prints on its own maps) instead. Reading
 * `TRLNAME` alone reduced Acadia from ~150 trails to one.
 */
function trailName(attributes: TrailAttributes): string | null {
  const candidate = attributes.TRLNAME?.trim()
    || attributes.MAPLABEL?.trim()
    || attributes.TRLALTNAME?.trim()

  return candidate || null
}

function trailKey(attributes: TrailAttributes): string | null {
  const unit = attributes.UNITCODE?.trim()
  const name = trailName(attributes)

  if (!unit || !name)
    return null

  return `${unit}|${name.toUpperCase()}`
}

export const npsSource: TrailSourceAdapter = {
  source: 'nps',

  async shards(): Promise<Shard[]> {
    const units = await fetchAllPages<UnitAttributes>(client, {
      endpoint: TRAILS_LAYER,
      where: PUBLIC_FILTER,
      outFields: ['UNITCODE'],
      returnGeometry: false,
      returnDistinctValues: true,
      orderByFields: 'UNITCODE',
    })

    const codes = new Set<string>()
    for (const unit of units) {
      const code = unit.attributes.UNITCODE?.trim()
      if (code)
        codes.add(code)
    }

    return [...codes].sort().map(code => ({
      source: 'nps' as const,
      key: `nps:${code}`,
      cursor: { unit: code },
    }))
  },

  async fetch(shard: Shard): Promise<SourceFetchResult> {
    const unit = String(shard.cursor.unit)

    const features = await fetchAllPages<TrailAttributes>(client, {
      endpoint: TRAILS_LAYER,
      where: `${PUBLIC_FILTER} AND UNITCODE = '${unit}'`,
      outFields: OUT_FIELDS as string[],
      orderByFields: 'OBJECTID',
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
      // Same-named but disconnected trails are common here too — a park will
      // have two "Lakeshore Trail" sections either side of a bay. Publishing
      // them separately beats joining them across the water.
      const routes = featureRoutes(segments)

      routes.forEach((network, index) => {
        const suffix = routes.length > 1 ? `#${index + 1}` : ''
        const trail = normalizeTrail(`${key}${suffix}`, segments, network)
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

  const primary = segments.reduce((best, candidate) =>
    scoreAttributes(candidate.attributes) > scoreAttributes(best.attributes) ? candidate : best,
  ).attributes

  const name = trailName(primary)
  if (!name)
    return null

  const park = primary.UNITNAME?.trim() || 'National Park Service'

  // This layer carries no elevation either, so ascent stays 0 rather than
  // being invented — see the same note in the Forest Service source.
  const ascent = 0
  const surface = normalizeSurface(primary.TRLSURFACE)
  const difficulty = deriveDifficulty(stats.distanceMiles, ascent)
  const accessible = /accessible|ada|wheelchair/i.test(`${primary.ACCESSNOTES ?? ''} ${primary.TRLCLASS ?? ''}`)

  const sourceId = `nps/${key}`

  const displayTags = new Set<string>(['national-park'])
  if (surface)
    displayTags.add(surface)
  if (stats.closed)
    displayTags.add('loop')
  if (accessible)
    displayTags.add('accessible')
  if (primary.SEASONAL && /y|true/i.test(primary.SEASONAL))
    displayTags.add('seasonal')

  const alternate = primary.TRLALTNAME?.trim()

  return {
    source: 'nps',
    sourceId,
    sourceUrl: `https://www.nps.gov/${(primary.UNITCODE ?? '').toLowerCase()}/`,

    name,
    location: `${park}, ${state.code}`,
    description: `${name} is a ${stats.distanceMiles}-mile ${difficulty} trail in ${park}, ${state.name}.${alternate && alternate !== name ? ` Also known as ${alternate}.` : ''}`,

    latitude: stats.centroid.lat,
    longitude: stats.centroid.lng,
    minLat: stats.minLat,
    maxLat: stats.maxLat,
    minLng: stats.minLng,
    maxLng: stats.maxLng,
    country: state.country,
    state: state.code,
    stateName: state.name,
    managedBy: park,

    distance: stats.distanceMiles,
    elevation: ascent,
    elevationHigh: 0,
    difficulty,
    routeType: deriveRouteType(stats.closed, true),
    surface,
    estimatedTime: estimateTime(stats.distanceMiles, ascent),
    geometry: encodeRouteGeometry(network.parts),

    allowedUses: deriveUses(primary),
    // The layer has no per-trail pet field. Policy varies by park (Acadia allows
    // leashed dogs on most trails), and a restrictive default was shown to
    // visitors as "Dogs are not permitted on this trail", so record it as
    // unknown.
    dogsAllowed: null,
    wheelchairAccessible: accessible,
    nationalTrail: false,

    image: pickImage(sourceId),
    tags: encodeTags(displayTags),
  }
}

function scoreAttributes(attributes: TrailAttributes): number {
  let score = 0
  if (trailName(attributes))
    score += 2
  if (attributes.TRLSURFACE)
    score++
  if (attributes.TRLUSE)
    score++
  if (attributes.ACCESSNOTES)
    score++
  if (attributes.UNITNAME)
    score++
  return score
}

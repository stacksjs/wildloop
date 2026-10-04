/**
 * Resolve a coordinate to a country and region, offline.
 *
 * Every ingested trail needs a region so the catalog can be browsed by one,
 * and with millions of features a per-point geocoding call is not an option.
 * The lookup is a bbox prefilter followed by ray casting against simplified
 * polygons (see `scripts/generate-us-states.ts` and
 * `scripts/generate-dach-regions.ts` for how the data is produced).
 *
 * Two datasets, one lookup: US states from the Census, and German, Austrian
 * and Swiss regions from Natural Earth. They keep separate files because they
 * come from separate sources on separate update cycles, but nothing downstream
 * needs to know which file a match came from.
 */

import dachData from './data/dach-regions.json' with { type: 'json' }
import statesData from './data/us-states.json' with { type: 'json' }

export interface RegionPolygon {
  code: string
  name: string
  country: string
  bbox: [number, number, number, number]
  rings: number[][][]
  /** Interior rings, where a region encloses another one. */
  holes?: number[][][]
}

export interface RegionMatch {
  /** ISO 3166-1 alpha-2, e.g. `US`, `DE`. */
  country: string
  /** `CO` for US states, ISO 3166-2 (`DE-BY`) elsewhere. */
  code: string
  /** Local-language name, e.g. `Colorado`, `Bayern`. */
  name: string
}

/**
 * Territories and freely-associated areas the Census returns alongside the
 * states. They are legitimately part of the dataset, but "trails in the US"
 * for this app means the 50 states plus DC, and their trails would otherwise
 * skew every "nearby" query run from the mainland.
 */
const NON_STATE_CODES = new Set(['AS', 'GU', 'MP', 'PR', 'VI'])

/** The US file predates the multi-country shape and carries no `country`. */
const usRegions: RegionPolygon[] = (statesData as unknown as Array<Omit<RegionPolygon, 'country'>>)
  .filter(state => !NON_STATE_CODES.has(state.code))
  .map(state => ({ ...state, country: 'US' }))

const dachRegions = dachData as unknown as RegionPolygon[]

const regions: RegionPolygon[] = [...usRegions, ...dachRegions]

/**
 * Standard even-odd ray casting. Points exactly on an edge are unstable here,
 * which is fine: a trail lying precisely on a border is arbitrary anyway.
 */
function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]

    const intersects = (yi > lat) !== (yj > lat)
      && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi

    if (intersects)
      inside = !inside
  }

  return inside
}

function inBbox(lng: number, lat: number, bbox: [number, number, number, number]): boolean {
  return lng >= bbox[0] && lng <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]
}

function contains(region: RegionPolygon, lat: number, lng: number): boolean {
  if (!inBbox(lng, lat, region.bbox))
    return false

  if (!region.rings.some(ring => pointInRing(lng, lat, ring)))
    return false

  // A point inside an enclave belongs to the enclave, not its surround. Berlin
  // sits entirely within Brandenburg, Wien within Niederösterreich and Bremen
  // within Niedersachsen; without this every trail in those cities would be
  // labelled with the Land around them.
  return !region.holes?.some(hole => pointInRing(lng, lat, hole))
}

/**
 * The region containing `lat`/`lng`, or `null` when the point is outside every
 * country the ingest covers.
 *
 * Multi-ring regions are handled by testing every ring: Michigan's two
 * peninsulas, Hawaii's islands and Alaska's archipelago are all separate rings
 * of one state, so any hit counts.
 *
 * `countries` narrows the search. The Forest Service and Park Service datasets
 * are US-only by definition, so a row of theirs landing in a German Land means
 * a bad coordinate, not a German trail — constraining them keeps that as a
 * dropped row rather than a plausible-looking one in the wrong country.
 */
export function resolveRegion(
  lat: number,
  lng: number,
  countries?: readonly string[],
): RegionMatch | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    return null

  for (const region of regions) {
    if (countries && !countries.includes(region.country))
      continue
    if (contains(region, lat, lng))
      return { country: region.country, code: region.code, name: region.name }
  }

  return null
}

/** Every region the ingest covers, in country then code order. */
export function allRegions(): RegionMatch[] {
  return regions.map(region => ({
    country: region.country,
    code: region.code,
    name: region.name,
  }))
}

/** The bounding box of a region, for tiling an ingest run region by region. */
export function regionBbox(code: string): [number, number, number, number] | null {
  return regions.find(region => region.code === code)?.bbox ?? null
}

/**
 * One region's polygon, by code, or `null` for a code the catalog does not
 * cover. Case-insensitive, since `co` and `de-by` are what people type.
 */
export function regionPolygon(code: string): RegionPolygon | null {
  const wanted = String(code ?? '').trim().toUpperCase()
  if (!wanted)
    return null
  return regions.find(region => region.code === wanted) ?? null
}

/** Whether a point lies in this region, with any enclave cut out of it. */
export function regionContains(region: RegionPolygon, lat: number, lng: number): boolean {
  return contains(region, lat, lng)
}

/** Every country code with regions loaded. */
export function coveredCountries(): string[] {
  return [...new Set(regions.map(region => region.country))].sort()
}

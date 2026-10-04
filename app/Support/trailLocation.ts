import { resolveRegion } from '../Ingest/regions'

/**
 * A better place name for a trail than its state.
 *
 * OpenStreetMap carries no place for a way, so the ingest wrote the one thing
 * it knew — the region the trail's middle falls in. Most of the catalog is
 * OSM, so most trails read "California" where a trail site says "Topanga State
 * Park" or "Pacific Palisades, CA": 76% of 2,190 trails sampled around Los
 * Angeles. A list of forty trails all "in California" says nothing about which
 * one is near you.
 *
 * Two answers, in order of preference:
 *
 *  1. The park or forest the trail is inside, borrowed from the agency rows
 *     around it. The Park Service and Forest Service label their own trails
 *     ("Angeles National Forest, CA"), so the catalog already knows where
 *     those units are — as points, though, not boundaries. "The nearest
 *     agency trail" alone is not enough: the Santa Monica Mountains NRA has
 *     trails a few kilometres from Hollywood Boulevard, and the Walk of Fame
 *     is not in a recreation area. So the label is only borrowed when the
 *     trail is surrounded by it — agency trails close by, on most sides,
 *     and no other unit competing for the same ground. A trail on a park's
 *     edge fails that and falls through to its town, which is still true.
 *
 *  2. The nearest town in the same region, from the GeoNames gazetteer,
 *     written the way the rest of the catalog writes places: "Pacific
 *     Palisades, CA" in the US and "Grainau, Bayern" in Germany, Austria and
 *     Switzerland. A town over the border is skipped rather than labelled with
 *     the wrong state — Leutasch is the nearest town to some Bavarian
 *     trails, and it is in Tirol.
 *
 * And one refusal: a location that already names something finer than the
 * region is never replaced. Agency rows, seeded rows and anything a person
 * curated stay exactly as they are.
 *
 * Pure: the caller looks up the neighbours and towns, this decides.
 */

export interface TrailPlace {
  location: string | null | undefined
  /** ISO 3166-1 alpha-2. */
  country: string | null | undefined
  /** USPS code in the US, ISO 3166-2 elsewhere (`DE-BY`). */
  state: string | null | undefined
  stateName: string | null | undefined
  latitude: number
  longitude: number
  minLat?: number | null
  maxLat?: number | null
  minLng?: number | null
  maxLng?: number | null
}

/** An agency trail near the one being named: its location, and where it is. */
export interface ManagedNeighbour {
  location: string
  latitude: number
  longitude: number
}

/** A gazetteer place near the trail, nearest first. */
export interface NearbyTown {
  name: string
  lat: number
  lng: number
  distanceKm: number
}

export type LocationBasis = 'managed' | 'town'

export interface LocationDecision {
  location: string
  basis: LocationBasis
}

/** How far around the trail to look for agency trails, and the radius the rules below are judged in. */
export const MANAGED_SEARCH_KM = 5

/**
 * The closest agency trail carrying the label must be this close.
 *
 * Duplicates of the same trail sit on top of each other, and a trail inside a
 * unit always has one of the unit's own trails within a kilometre or so. The
 * Walk of Fame's nearest Santa Monica Mountains trail is 6 km off.
 */
const MANAGED_NEAR_KM = 1.5

/** At least this many of the unit's trails around the point. One trail is a coincidence. */
const MANAGED_MIN_ROWS = 4

/**
 * Of the agency trails around the point, the share that must carry the label.
 * Below it two units meet here, and the trail could be in either.
 */
const MANAGED_MIN_SHARE = 0.8

/**
 * The unit's trails must lie on at least this many sides of the point — the
 * four quadrants around it. A park's interior has its trails all around; a
 * town at its edge has them on one side.
 */
const MANAGED_MIN_QUADRANTS = 3

/** Trails nearer than this are the same place, and say nothing about direction. */
const SAME_SPOT_KM = 0.2

/**
 * Agency labels that name an agency rather than a place. The Park Service
 * row falls back to its service's name when a unit has none, and the Forest
 * Service row to its system's.
 */
const GENERIC_LABELS = new Set(['national park service', 'national forest system'])

/** A town further than this is not where the trail is. */
export const TOWN_MAX_KM = 25

/**
 * Trails wider than this keep their region.
 *
 * A 200-mile relation's middle is near some town, and naming it would say the
 * whole trail is there. A unit's name stretches further than a town's, so
 * an agency label is allowed further.
 */
const TOWN_MAX_SPAN_KM = 25
const MANAGED_MAX_SPAN_KM = 50

/**
 * GeoNames writes a handful of large German-speaking cities in English. The
 * catalog writes the region in its own language ("Bayern"), and "Munich,
 * Bayern" mixes the two.
 */
const LOCAL_NAMES: Record<string, string> = {
  Munich: 'München',
  Nuremberg: 'Nürnberg',
  Vienna: 'Wien',
  Geneva: 'Genève',
}

function fold(text: unknown): string {
  return String(text ?? '').normalize('NFC').trim().toLowerCase()
}

/**
 * Whether a trail's location says nothing finer than its region: empty, the
 * region's name ("California", "Bayern"), or its code ("CA").
 */
export function namesOnlyRegion(row: Pick<TrailPlace, 'location' | 'state' | 'stateName'>): boolean {
  const location = fold(row.location)
  if (!location)
    return true
  return location === fold(row.stateName) || location === fold(row.state)
}

/** Kilometres between two points. Equirectangular: exact enough at these distances, and cheap. */
export function kmBetween(a: { lat: number, lng: number }, b: { lat: number, lng: number }): number {
  const meanLat = ((a.lat + b.lat) / 2) * Math.PI / 180
  const dx = (b.lng - a.lng) * Math.cos(meanLat) * 111.32
  const dy = (b.lat - a.lat) * 110.57
  return Math.sqrt(dx * dx + dy * dy)
}

/** The diagonal of a trail's bounding box, or 0 when it has none. */
export function spanKm(row: TrailPlace): number {
  const { minLat, maxLat, minLng, maxLng } = row
  if (![minLat, maxLat, minLng, maxLng].every(value => typeof value === 'number' && Number.isFinite(value)))
    return 0
  if (minLat === 0 && maxLat === 0 && minLng === 0 && maxLng === 0)
    return 0
  return kmBetween({ lat: minLat as number, lng: minLng as number }, { lat: maxLat as number, lng: maxLng as number })
}

/**
 * The park or forest a trail is inside, judged from the agency trails around
 * it, or null when it cannot be said with confidence.
 */
export function managedAreaAround(row: TrailPlace, neighbours: ManagedNeighbour[]): string | null {
  const state = String(row.state ?? '').trim()
  if (!state || row.country !== 'US')
    return null

  const point = { lat: row.latitude, lng: row.longitude }
  const suffix = `, ${state}`.toLowerCase()

  const around: Array<{ label: string, km: number, quadrant: number | null }> = []
  for (const neighbour of neighbours) {
    const label = String(neighbour.location ?? '').trim()
    if (!label)
      continue
    const km = kmBetween(point, { lat: neighbour.latitude, lng: neighbour.longitude })
    if (!Number.isFinite(km) || km > MANAGED_SEARCH_KM)
      continue
    const quadrant = km < SAME_SPOT_KM
      ? null
      : (neighbour.latitude >= point.lat ? 0 : 2) + (neighbour.longitude >= point.lng ? 0 : 1)
    around.push({ label, km, quadrant })
  }
  if (around.length === 0)
    return null

  const byLabel = new Map<string, typeof around>()
  for (const entry of around) {
    const list = byLabel.get(entry.label) ?? []
    list.push(entry)
    byLabel.set(entry.label, list)
  }

  const [label, rows] = [...byLabel.entries()].sort((a, b) => b[1].length - a[1].length)[0]

  // A unit across the state line: "Lake Tahoe Basin Management Unit, NV" is
  // not where a California trail is, even when it is next door.
  if (!label.toLowerCase().endsWith(suffix))
    return null
  if (GENERIC_LABELS.has(label.slice(0, -suffix.length).trim().toLowerCase()))
    return null

  if (rows.length < MANAGED_MIN_ROWS)
    return null
  if (rows.length / around.length < MANAGED_MIN_SHARE)
    return null
  if (Math.min(...rows.map(entry => entry.km)) > MANAGED_NEAR_KM)
    return null

  const quadrants = new Set(rows.map(entry => entry.quadrant).filter(quadrant => quadrant !== null))
  if (quadrants.size < MANAGED_MIN_QUADRANTS)
    return null

  return label
}

/**
 * "Pacific Palisades, CA", "Grainau, Bayern" — a town written the way the
 * catalog writes places in its country.
 */
export function formatTownLocation(town: string, row: Pick<TrailPlace, 'country' | 'state' | 'stateName'>): string {
  const name = LOCAL_NAMES[town] ?? town
  return row.country === 'US'
    ? `${name}, ${String(row.state ?? '').trim()}`
    : `${name}, ${String(row.stateName ?? '').trim()}`
}

/** The nearest town in the trail's own region, formatted, or null. */
export function townAround(row: TrailPlace, towns: NearbyTown[]): string | null {
  if (!String(row.state ?? '').trim() || !String(row.stateName ?? '').trim())
    return null

  const sorted = [...towns].sort((a, b) => a.distanceKm - b.distanceKm)
  for (const town of sorted) {
    if (!(town.distanceKm <= TOWN_MAX_KM))
      break
    const name = String(town.name ?? '').trim()
    if (!name)
      continue

    // Across the border, the town is the nearest one but the wrong state:
    // keep looking for the nearest on this side.
    const region = resolveRegion(town.lat, town.lng)
    if (!region || region.country !== row.country || region.code !== row.state)
      continue

    // Berlin in Berlin, Hamburg in Hamburg: "Berlin, Berlin" is the region
    // twice, and the region alone already says it.
    if (fold(LOCAL_NAMES[name] ?? name) === fold(row.stateName))
      return null

    return formatTownLocation(name, row)
  }
  return null
}

/**
 * The location a trail should carry instead of its current one, or null to
 * leave it alone.
 */
export function betterLocation(
  row: TrailPlace,
  nearby: { managed: ManagedNeighbour[], towns: NearbyTown[] },
): LocationDecision | null {
  if (!namesOnlyRegion(row))
    return null
  if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude))
    return null
  if (row.latitude === 0 && row.longitude === 0)
    return null

  const span = spanKm(row)

  if (span <= MANAGED_MAX_SPAN_KM) {
    const managed = managedAreaAround(row, nearby.managed)
    if (managed)
      return { location: managed, basis: 'managed' }
  }

  if (span <= TOWN_MAX_SPAN_KM) {
    const town = townAround(row, nearby.towns)
    if (town)
      return { location: town, basis: 'town' }
  }

  return null
}

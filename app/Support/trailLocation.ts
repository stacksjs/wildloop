import { resolveRegion } from '../Ingest/regions'
import { NEAR_PLACE_PREFIX } from '../../resources/functions/trail-page'

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
 * The answers, in order of preference:
 *
 *  1. The park, forest or refuge the trail's own operator tag names
 *     ("Colville National Forest", "Baxter State Park Authority"). OSM has
 *     no place for a way, but a mapper often recorded who runs it, and a
 *     unit that runs a trail is where the trail is. A federal unit is only
 *     taken when the catalog's agency rows know a unit by that name, which
 *     keeps a misspelt tag ("Coville National Forest") off the card.
 *
 *  2. The park or forest the trail is inside, borrowed from the agency rows
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
 *  3. The nearest town in the same region, from the GeoNames gazetteer,
 *     written the way the rest of the catalog writes places: "Pacific
 *     Palisades, CA" in the US and "Grainau, Bayern" in Germany, Austria and
 *     Switzerland. A town over the border is skipped rather than labelled with
 *     the wrong state — Leutasch is the nearest town to some Bavarian
 *     trails, and it is in Tirol. Which side a town is on is the
 *     gazetteer's own record, not the simplified region outlines.
 *
 *  4. Out in the back country, with no town of its region within 25 km, the
 *     park or forest again, judged from a wider circle. Agency trails there
 *     are a few kilometres apart rather than a few hundred metres, and there
 *     is no town for a unit's edge to be confused with. The bar for "on
 *     most sides" stays, and the share that must agree rises.
 *
 *  5. Then the nearest town of its region within 45 km, said honestly:
 *     "Near Republic, WA" rather than "Republic, WA". Only when no town at
 *     all, on either side of a border, is within 25 km — a trail 8 km from
 *     a Nevada town is not usefully "near" a California one 45 km off.
 *
 * And two refusals. A location that already names something finer than the
 * region is never replaced: agency rows, seeded rows and anything a person
 * curated stay exactly as they are. And a trail with nothing honest to be
 * named by keeps its region, which is at least true.
 *
 * A town is never named across a ridge. Mountain country is mostly forest
 * and park, and those trails take the unit's name before any town is asked
 * about; for a town more than 10 km off, the caller also reads the ground
 * along the line between them (`crossesRidge()`) and keeps the region when
 * a range stands in the way.
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
  /** Who runs the trail, from the source (OSM `operator`). */
  managedBy?: string | null
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
  /** GeoNames feature code: `PPL`, `PPLA2`, `PPLX` (a section of a city)… */
  feature?: string | null
  /** ISO 3166-1 alpha-2, from GeoNames. */
  country?: string | null
  /** GeoNames admin1 code: `CA`, `AR` (a canton), `02` (Bayern, or Kärnten). */
  regionCode?: string | null
}

export type LocationBasis = 'operator' | 'managed' | 'town' | 'near-town'

export interface LocationDecision {
  location: string
  basis: LocationBasis
  /**
   * Where the town is, for an answer naming one further than
   * `RIDGE_CHECK_FROM_KM` — every `near-town` answer, and a `town` one 10-25
   * km off. The caller still has to see that no ridge stands between the
   * two (`crossesRidge()`) before the answer is written.
   */
  town?: { lat: number, lng: number }
}

/** What is known around a trail when it is named. */
export interface PlaceLookup {
  managed: ManagedNeighbour[]
  towns: NearbyTown[]
  /**
   * The federal units the catalog's agency rows name, by `unitKey()`, each
   * to its own spelling ("Mt. Baker-Snoqualmie National Forest"). Without
   * it, an operator tag naming a federal unit is not taken.
   */
  units?: ReadonlyMap<string, string>
}

/** How surrounded by one unit's trails a point must be to borrow its name. */
interface ManagedRule {
  /** The circle the rule is judged in. */
  searchKm: number
  /** The closest of the unit's trails must be this close. */
  nearKm: number
  /** At least this many of the unit's trails in the circle. */
  minRows: number
  /** Of the agency trails in the circle, the share that must carry the label. */
  minShare: number
  /** The unit's trails must lie in at least this many of the four quadrants. */
  minQuadrants: number
}

/**
 * Among towns. Duplicates of the same trail sit on top of each other, and a
 * trail inside a unit always has one of the unit's own trails within a
 * kilometre or so; the Walk of Fame's nearest Santa Monica Mountains trail is
 * 6 km off. One trail is a coincidence, and below 80% two units meet here.
 * A park's interior has its trails all around; a town at its edge has them
 * on one side.
 */
const MANAGED_IN_TOWN: ManagedRule = { searchKm: 5, nearKm: 1.5, minRows: 4, minShare: 0.8, minQuadrants: 3 }

/**
 * In the back country, where no town of the region is within 25 km. Agency
 * trails are sparser there, so the circle doubles and the nearest may be
 * further, and nine in ten must agree rather than eight. Checked against
 * production: of 3,783 agency trails out of town, left out one at a time,
 * 2,311 were named by the trails around them and every one correctly; of 763
 * OSM trails that a county, BLM, a state park or a land trust runs, one was
 * put in a national forest it sits at the edge of.
 */
const MANAGED_OUT_OF_TOWN: ManagedRule = { searchKm: 10, nearKm: 2.5, minRows: 4, minShare: 0.9, minQuadrants: 3 }

/** How far around the trail the caller must look for agency trails: the widest circle above. */
export const MANAGED_SEARCH_KM = MANAGED_OUT_OF_TOWN.searchKm

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
 * A town further than this is not even near it. Past 45 km the nearest town
 * is a different valley, or the other side of a range, as often as not.
 */
export const NEAR_TOWN_MAX_KM = 45

/** How far around the trail the caller must look for towns. */
export const TOWN_SEARCH_KM = NEAR_TOWN_MAX_KM

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
 * GeoNames places that are not a town to be near: a section of a city, and
 * places that were (historical, abandoned, destroyed).
 */
const NOT_A_TOWN = new Set(['PPLX', 'PPLH', 'PPLQ', 'PPLW'])

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
 * it, or null when it cannot be said with confidence. `remote` judges it the
 * way the back country needs (see `MANAGED_OUT_OF_TOWN`).
 */
export function managedAreaAround(row: TrailPlace, neighbours: ManagedNeighbour[], remote = false): string | null {
  const rule = remote ? MANAGED_OUT_OF_TOWN : MANAGED_IN_TOWN
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
    if (!Number.isFinite(km) || km > rule.searchKm)
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

  if (rows.length < rule.minRows)
    return null
  if (rows.length / around.length < rule.minShare)
    return null
  if (Math.min(...rows.map(entry => entry.km)) > rule.nearKm)
    return null

  const quadrants = new Set(rows.map(entry => entry.quadrant).filter(quadrant => quadrant !== null))
  if (quadrants.size < rule.minQuadrants)
    return null

  return label
}

/**
 * A unit's name reduced for comparison: "Mt. Baker-Snoqualmie National
 * Forest" and "mt baker snoqualmie national forests" are the same unit.
 */
export function unitKey(name: string): string {
  return fold(name)
    .replace(/&/g, ' and ')
    .replace(/\bmt\b\.?/g, 'mount')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\bforests\b/g, 'forest')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Federal designations, which the agency rows know every unit of. */
const FEDERAL_UNIT = /\sNational\s(?:Forests?|Park|Parks|Monument|Recreation Area|Seashore|Lakeshore|Preserve|Grasslands?|Scenic Area)$/i

/** Designations the agency rows do not cover, taken as the tag spells them. */
const OTHER_UNIT = /\s(?:National Wildlife Refuge|State Park|State Forest|State Recreation Area)$/i

/** A German-speaking park, named designation first ("Naturpark Altmühltal"). */
const ALPINE_UNIT = /^(?:Naturpark|Nationalpark|Biosphärenreservat)\s\p{Lu}[\p{L}\s.-]*$/u

/** Who runs a unit, written in front of it: "USFS Tahoe National Forest". */
const AGENCY_PREFIX = /^(?:usfs|usda forest service|u\.?\s?s\.?\s+forest service|national park service)\s*[-–:]?\s+/i

/** A body rather than a place, even with a unit's name in it. */
const NOT_A_UNIT = /^(?:friends of|the\s)|\b(?:e\.\s?V\.?|verwaltung|verband|verein|und|district)\b/i

/**
 * The park, forest or refuge a trail's operator tag names, written the way
 * the catalog writes a unit ("Colville National Forest, WA"), or null.
 */
export function operatorUnit(row: TrailPlace, units?: ReadonlyMap<string, string>): string | null {
  const region = row.country === 'US' ? String(row.state ?? '').trim() : String(row.stateName ?? '').trim()
  if (!region)
    return null

  // "United States National Park Service;North Country Trail Association":
  // each body in a list on its own.
  for (const part of String(row.managedBy ?? '').split(';')) {
    const name = part
      .replace(/\s+/g, ' ')
      .trim()
      .replace(AGENCY_PREFIX, '')
      .replace(/\s+Authority$/i, '')
      .replace(/\sNWR$/, ' National Wildlife Refuge')
    if (!name || NOT_A_UNIT.test(name))
      continue

    if (row.country === 'US' && FEDERAL_UNIT.test(name)) {
      // The agency rows spell every federal unit; a tag that matches none of
      // them is a typo or an old name.
      const known = units?.get(unitKey(name))
      if (known && !GENERIC_LABELS.has(known.toLowerCase()))
        return `${known}, ${region}`
      continue
    }

    if (row.country === 'US' && OTHER_UNIT.test(name) && name.split(' ').length >= 3)
      return `${name}, ${region}`

    if (row.country !== 'US' && ALPINE_UNIT.test(name))
      return `${name}, ${region}`
  }
  return null
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

/**
 * GeoNames numbers the German Länder in its own order. Austria's numbers are
 * ISO's with a leading zero, and the US and Swiss codes are ISO's own.
 */
const GEONAMES_DE: Record<string, string> = {
  'DE-BW': '01',
  'DE-BY': '02',
  'DE-HB': '03',
  'DE-HH': '04',
  'DE-HE': '05',
  'DE-NI': '06',
  'DE-NW': '07',
  'DE-RP': '08',
  'DE-SL': '09',
  'DE-SH': '10',
  'DE-BB': '11',
  'DE-MV': '12',
  'DE-SN': '13',
  'DE-ST': '14',
  'DE-TH': '15',
  'DE-BE': '16',
}

/** The GeoNames admin1 code of a trail's region, or null for a country it does not know. */
export function geonamesRegionCode(row: Pick<TrailPlace, 'country' | 'state'>): string | null {
  const state = String(row.state ?? '').trim()
  if (!state)
    return null
  switch (row.country) {
    case 'US': return state
    case 'CH': return state.replace(/^CH-/, '')
    case 'AT': return state.replace(/^AT-(\d)$/, '0$1')
    case 'DE': return GEONAMES_DE[state] ?? null
    default: return null
  }
}

/**
 * Whether a town is in the trail's region.
 *
 * By the gazetteer's own record of where the town is, when it has one. The
 * region outlines are simplified, and around Appenzell's enclaves they put
 * Gais and Walzenhausen — both in Ausserrhoden — inside Innerrhoden. The
 * outlines are only the fallback, for a town that came with no region.
 */
function inTrailRegion(town: NearbyTown, row: TrailPlace): boolean {
  const expected = geonamesRegionCode(row)
  if (town.country && town.regionCode && expected)
    return town.country === row.country && town.regionCode === expected
  if (town.country && town.country !== row.country)
    return false
  const region = resolveRegion(town.lat, town.lng)
  return !!region && region.country === row.country && region.code === row.state
}

/** Towns in the trail's own region, nearest first, out to `maxKm`. */
function townsOfRegion(row: TrailPlace, towns: NearbyTown[], maxKm: number): NearbyTown[] {
  const own: NearbyTown[] = []
  for (const town of [...towns].sort((a, b) => a.distanceKm - b.distanceKm)) {
    if (!(town.distanceKm <= maxKm))
      break
    if (!String(town.name ?? '').trim() || NOT_A_TOWN.has(String(town.feature ?? '')))
      continue
    // Across the border, the town is the nearest one but the wrong state.
    if (!inTrailRegion(town, row))
      continue
    own.push(town)
  }
  return own
}

/** Berlin in Berlin, Hamburg in Hamburg: a town that is the region itself. */
function isTheRegion(town: NearbyTown, row: TrailPlace): boolean {
  const name = String(town.name ?? '').trim()
  return fold(LOCAL_NAMES[name] ?? name) === fold(row.stateName)
}

/** The nearest town in the trail's own region, formatted, or null. */
export function townAround(row: TrailPlace, towns: NearbyTown[]): string | null {
  return townOf(row, towns)?.location ?? null
}

function townOf(row: TrailPlace, towns: NearbyTown[]): { location: string, town: NearbyTown } | null {
  if (!String(row.state ?? '').trim() || !String(row.stateName ?? '').trim())
    return null

  const [town] = townsOfRegion(row, towns, TOWN_MAX_KM)
  // "Berlin, Berlin" is the region twice, and the region alone already says it.
  if (!town || isTheRegion(town, row))
    return null
  return { location: formatTownLocation(String(town.name).trim(), row), town }
}

/**
 * "Near Republic, WA": the nearest town of the region when it is more than
 * `TOWN_MAX_KM` off but within `NEAR_TOWN_MAX_KM`, or null.
 *
 * Only for a trail with no town of any region within `TOWN_MAX_KM`: a trail
 * 8 km from a Nevada town is not usefully near a California one 45 km away,
 * and naming it after the Nevada town would put a Nevada place in a
 * California list.
 */
export function townNear(row: TrailPlace, towns: NearbyTown[]): { location: string, town: NearbyTown } | null {
  if (!String(row.state ?? '').trim() || !String(row.stateName ?? '').trim())
    return null
  const anyClose = towns.some(town => town.distanceKm <= TOWN_MAX_KM && !NOT_A_TOWN.has(String(town.feature ?? '')))
  if (anyClose)
    return null

  const [town] = townsOfRegion(row, towns, NEAR_TOWN_MAX_KM)
  if (!town || isTheRegion(town, row))
    return null
  return { location: `${NEAR_PLACE_PREFIX}${formatTownLocation(String(town.name).trim(), row)}`, town }
}

/** Heights asked for along the line from a trail to the town it would be named after. */
export const RIDGE_SAMPLES = 40

/**
 * A town further off than this is only named once the ground between has
 * been looked at. In the Alps the nearest town of the canton can be the far
 * side of a range: the only Graubünden town in the gazetteer for Val
 * Müstair is Scuol, 20 km north over the Sesvenna group.
 */
export const RIDGE_CHECK_FROM_KM = 10

/**
 * How far the ground between a trail and its town may rise above the higher
 * of the two before it is a ridge between them rather than a hillside.
 *
 * Lunch Meadow, in the Emigrant Wilderness at 2,600 m, is 36 km from
 * Bridgeport across the Sierra crest, which the straight line between them
 * crosses well above 3,000 m: by road the two are three hours apart. A
 * trail on a valley side, below a shoulder a hundred metres higher than it,
 * is still near the town at the valley mouth.
 */
export const RIDGE_RISE_M = 300

/** `count` points evenly along the straight line from `a` to `b`, both ends included. */
export function pointsBetween(a: { lat: number, lng: number }, b: { lat: number, lng: number }, count = RIDGE_SAMPLES): Array<{ lat: number, lng: number }> {
  const n = Math.max(2, Math.floor(count))
  return Array.from({ length: n }, (_, i) => ({
    lat: a.lat + (b.lat - a.lat) * i / (n - 1),
    lng: a.lng + (b.lng - a.lng) * i / (n - 1),
  }))
}

/**
 * Whether the ground along a line from a trail to a town (heights in
 * metres, trail first) rises past `RIDGE_RISE_M` above both ends.
 *
 * Null when it cannot be told: either end unknown, or most of the line. A
 * town is only written as near when this is known to be false.
 */
export function crossesRidge(heights: Array<number | null | undefined>): boolean | null {
  const valid = heights.filter((h): h is number => typeof h === 'number' && Number.isFinite(h))
  const first = heights[0]
  const last = heights[heights.length - 1]
  if (typeof first !== 'number' || typeof last !== 'number' || !Number.isFinite(first) || !Number.isFinite(last))
    return null
  if (valid.length < heights.length * 0.8)
    return null
  const ceiling = Math.max(first, last) + RIDGE_RISE_M
  return valid.some(h => h > ceiling)
}

/**
 * The location a trail should carry instead of its current one, or null to
 * leave it alone.
 */
export function betterLocation(row: TrailPlace, nearby: PlaceLookup): LocationDecision | null {
  if (!namesOnlyRegion(row))
    return null
  if (!Number.isFinite(row.latitude) || !Number.isFinite(row.longitude))
    return null
  if (row.latitude === 0 && row.longitude === 0)
    return null

  const operator = operatorUnit(row, nearby.units)
  if (operator)
    return { location: operator, basis: 'operator' }

  const span = spanKm(row)

  if (span <= MANAGED_MAX_SPAN_KM) {
    const managed = managedAreaAround(row, nearby.managed)
    if (managed)
      return { location: managed, basis: 'managed' }
  }

  if (span <= TOWN_MAX_SPAN_KM) {
    const found = townOf(row, nearby.towns)
    if (found) {
      // A town this close needs no look at the ground between.
      return found.town.distanceKm > RIDGE_CHECK_FROM_KM
        ? { location: found.location, basis: 'town', town: { lat: found.town.lat, lng: found.town.lng } }
        : { location: found.location, basis: 'town' }
    }
  }

  // Everything below is for the back country: a trail with a town of its own
  // region close by has had its answer, or has none.
  if (townsOfRegion(row, nearby.towns, TOWN_MAX_KM).length > 0)
    return null

  if (span <= MANAGED_MAX_SPAN_KM) {
    const managed = managedAreaAround(row, nearby.managed, true)
    if (managed)
      return { location: managed, basis: 'managed' }
  }

  if (span <= TOWN_MAX_SPAN_KM) {
    const near = townNear(row, nearby.towns)
    if (near)
      return { location: near.location, basis: 'near-town', town: { lat: near.town.lat, lng: near.town.lng } }
  }

  return null
}

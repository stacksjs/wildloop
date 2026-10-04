import { openGazetteer } from './gazetteer'

export interface PlacePoint {
  lat: number
  lng: number
}

/** A state, Land or canton a named region lies in, as `agrees()` reads a place. */
interface RegionPart {
  regionCode: string
  region: string
  country: string
  countryName: string
}

interface NamedRegion {
  /** What people call it, in every spelling worth accepting. Folded before matching. */
  names: string[]
  /** A representative point: the middle of where its people live, near enough to sort by. */
  point: PlacePoint
  /** Every state it spans, in each spelling a hint after the comma might use. */
  within: RegionPart[]
}

function us(regionCode: string, region: string): RegionPart {
  return { regionCode, region, country: 'US', countryName: 'United States' }
}
function de(regionCode: string, region: string): RegionPart {
  return { regionCode, region, country: 'DE', countryName: 'Germany' }
}
function at(region: string): RegionPart {
  return { regionCode: '', region, country: 'AT', countryName: 'Austria' }
}
function ch(regionCode: string, region: string): RegionPart {
  return { regionCode, region, country: 'CH', countryName: 'Switzerland' }
}

/**
 * Regions clubs name themselves after that no gazetteer has as a town.
 *
 * GeoNames lists towns, so "Bay Area, CA" is not in it, and its nearest
 * spelling is Qianhai Bay Area in Guangdong — which `agrees()` rightly
 * refuses. Such a club was never placed, so it sorted after every club near
 * anyone, however near it was. This is the short list of regions people
 * write instead of a town, each pinned near the middle of where its people
 * live.
 *
 * Kept to metro-sized regions and ranges on purpose. "SoCal" or "the
 * Midwest" pinned to one point would call a club near people it is hundreds
 * of miles from, which is worse than leaving it unplaced; "South Bay" and
 * "North Shore" name different places in different states, so they are not
 * here either.
 */
const NAMED_REGIONS: NamedRegion[] = [
  // United States
  { names: ['bay area', 'sf bay area', 'san francisco bay area'], point: { lat: 37.8044, lng: -122.2712 }, within: [us('CA', 'California')] },
  { names: ['east bay'], point: { lat: 37.8716, lng: -122.2727 }, within: [us('CA', 'California')] },
  { names: ['silicon valley'], point: { lat: 37.3688, lng: -122.0363 }, within: [us('CA', 'California')] },
  { names: ['inland empire'], point: { lat: 34.0555, lng: -117.35 }, within: [us('CA', 'California')] },
  { names: ['orange county'], point: { lat: 33.7175, lng: -117.8311 }, within: [us('CA', 'California')] },
  { names: ['san fernando valley'], point: { lat: 34.2011, lng: -118.46 }, within: [us('CA', 'California')] },
  { names: ['san gabriel valley'], point: { lat: 34.09, lng: -118.03 }, within: [us('CA', 'California')] },
  { names: ['lake tahoe', 'tahoe'], point: { lat: 39.0968, lng: -120.0324 }, within: [us('CA', 'California'), us('NV', 'Nevada')] },
  { names: ['front range'], point: { lat: 39.7392, lng: -104.9903 }, within: [us('CO', 'Colorado')] },
  { names: ['wasatch front'], point: { lat: 40.7608, lng: -111.891 }, within: [us('UT', 'Utah')] },
  { names: ['treasure valley'], point: { lat: 43.615, lng: -116.2023 }, within: [us('ID', 'Idaho')] },
  { names: ['puget sound'], point: { lat: 47.6062, lng: -122.3321 }, within: [us('WA', 'Washington')] },
  { names: ['twin cities'], point: { lat: 44.9537, lng: -93.17 }, within: [us('MN', 'Minnesota')] },
  { names: ['research triangle'], point: { lat: 35.8992, lng: -78.8636 }, within: [us('NC', 'North Carolina')] },
  { names: ['lehigh valley'], point: { lat: 40.6084, lng: -75.4902 }, within: [us('PA', 'Pennsylvania')] },
  { names: ['hudson valley'], point: { lat: 41.7004, lng: -73.921 }, within: [us('NY', 'New York')] },
  {
    names: ['tri state area', 'tri state'],
    point: { lat: 40.7128, lng: -74.006 },
    within: [us('NY', 'New York'), us('NJ', 'New Jersey'), us('CT', 'Connecticut')],
  },
  {
    names: ['dmv', 'dc metro', 'dc area'],
    point: { lat: 38.9072, lng: -77.0369 },
    within: [us('DC', 'District of Columbia'), us('MD', 'Maryland'), us('VA', 'Virginia')],
  },
  { names: ['hill country', 'texas hill country'], point: { lat: 30.2752, lng: -98.872 }, within: [us('TX', 'Texas')] },
  { names: ['valley of the sun'], point: { lat: 33.4484, lng: -112.074 }, within: [us('AZ', 'Arizona')] },
  { names: ['cape cod'], point: { lat: 41.6688, lng: -70.2962 }, within: [us('MA', 'Massachusetts')] },

  // Germany, Austria and Switzerland, with the local and the English names
  // of each, since clubs write either.
  { names: ['ruhrgebiet', 'ruhr', 'ruhrpott', 'ruhr area'], point: { lat: 51.4818, lng: 7.2162 }, within: [de('NW', 'Nordrhein-Westfalen'), de('NRW', 'North Rhine-Westphalia')] },
  { names: ['rhein main', 'rhein main gebiet', 'rhine main'], point: { lat: 50.1109, lng: 8.6821 }, within: [de('HE', 'Hessen'), de('HE', 'Hesse')] },
  { names: ['rhein neckar', 'rhine neckar'], point: { lat: 49.4875, lng: 8.466 }, within: [de('BW', 'Baden-Württemberg')] },
  { names: ['allgau', 'allgaeu'], point: { lat: 47.7267, lng: 10.3139 }, within: [de('BY', 'Bayern'), de('BY', 'Bavaria')] },
  { names: ['oberbayern', 'upper bavaria'], point: { lat: 48.1374, lng: 11.5755 }, within: [de('BY', 'Bayern'), de('BY', 'Bavaria')] },
  { names: ['frankische schweiz', 'franconian switzerland'], point: { lat: 49.77, lng: 11.33 }, within: [de('BY', 'Bayern'), de('BY', 'Bavaria')] },
  { names: ['bayerischer wald', 'bavarian forest'], point: { lat: 48.95, lng: 13.4 }, within: [de('BY', 'Bayern'), de('BY', 'Bavaria')] },
  { names: ['schwarzwald', 'black forest'], point: { lat: 48.0, lng: 8.2 }, within: [de('BW', 'Baden-Württemberg')] },
  { names: ['sachsische schweiz', 'saxon switzerland'], point: { lat: 50.92, lng: 14.15 }, within: [de('SN', 'Sachsen'), de('SN', 'Saxony')] },
  { names: ['harz'], point: { lat: 51.75, lng: 10.62 }, within: [de('NI', 'Niedersachsen'), de('ST', 'Sachsen-Anhalt')] },
  { names: ['eifel'], point: { lat: 50.35, lng: 6.75 }, within: [de('RP', 'Rheinland-Pfalz'), de('NW', 'Nordrhein-Westfalen')] },
  { names: ['salzkammergut'], point: { lat: 47.711, lng: 13.62 }, within: [at('Oberösterreich'), at('Salzburg'), at('Steiermark')] },
  { names: ['zillertal'], point: { lat: 47.1667, lng: 11.8667 }, within: [at('Tirol'), at('Tyrol')] },
  { names: ['wachau'], point: { lat: 48.37, lng: 15.42 }, within: [at('Niederösterreich'), at('Lower Austria')] },
  { names: ['berner oberland', 'bernese oberland'], point: { lat: 46.6863, lng: 7.8632 }, within: [ch('BE', 'Bern'), ch('BE', 'Berne')] },
  { names: ['engadin', 'engadine'], point: { lat: 46.4908, lng: 9.8355 }, within: [ch('GR', 'Graubünden'), ch('GR', 'Grisons')] },
  {
    names: ['bodensee', 'lake constance'],
    point: { lat: 47.6603, lng: 9.1758 },
    within: [de('BW', 'Baden-Württemberg'), de('BY', 'Bayern'), at('Vorarlberg'), ch('TG', 'Thurgau'), ch('SG', 'St. Gallen')],
  },
]

/** Lowercase, accents and punctuation gone, no leading "the": "The Tri-State Area" is "tri state area". */
function foldName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '')
}

const REGION_BY_NAME = new Map<string, NamedRegion>()
for (const region of NAMED_REGIONS) {
  for (const name of region.names)
    REGION_BY_NAME.set(foldName(name), region)
}

/**
 * The point for a region someone typed ("Bay Area, CA", "Allgäu"), or null
 * when the text is not one of the named regions or its hint names somewhere
 * else: "Bay Area, TX" is Houston's, not this one.
 */
export function placeOfRegion(typed: string): PlacePoint | null {
  const [first, ...rest] = String(typed ?? '').split(',').map(part => part.trim())
  const region = REGION_BY_NAME.get(foldName(first ?? ''))
  if (!region)
    return null
  const hint = rest.filter(Boolean).join(' ').toLowerCase()
  return region.within.some(part => agrees(part, hint)) ? { ...region.point } : null
}

/**
 * Where a place someone typed is, or null when it cannot be said with
 * confidence.
 *
 * Clubs carry a location as free text ("Boulder, CO", "Innsbruck, AT"). The
 * gazetteer answers a bare search with its most populous match, which is
 * right for "Boulder, CO" and badly wrong for "Bay Area, CA": that is
 * Qianhai Bay Area, in Guangdong. A club placed in China is worse than a club
 * placed nowhere — nowhere sorts last, China sorts as the far side of the
 * world — so a match is only accepted when it agrees with whatever follows
 * the comma: a state or region code, a country code, or a region's name.
 *
 * Answers are remembered for the life of the process. A club's location only
 * changes when somebody edits it, and the gazetteer is read from disk.
 */
const remembered = new Map<string, PlacePoint | null>()
const REMEMBER_AT_MOST = 2000

export function placeOfText(text: unknown): PlacePoint | null {
  const typed = String(text ?? '').trim()
  if (!typed)
    return null

  const key = typed.toLowerCase()
  if (remembered.has(key))
    return remembered.get(key) ?? null

  const point = lookUp(typed)
  if (remembered.size >= REMEMBER_AT_MOST)
    remembered.clear()
  remembered.set(key, point)
  return point
}

function lookUp(typed: string): PlacePoint | null {
  // Regions first. The list is explicit, so a match is meant; the
  // gazetteer's nearest spelling of a region is somewhere else entirely.
  const region = placeOfRegion(typed)
  if (region)
    return region

  const gazetteer = openGazetteer()
  if (!gazetteer)
    return null

  const [first, ...rest] = typed.split(',').map(part => part.trim())
  const city = (first ?? '').toLowerCase()
  const hint = rest.filter(Boolean).join(' ').toLowerCase()

  try {
    const results = gazetteer.searchSync(typed, { limit: 5 }) as Array<{
      center?: { lat?: number, lng?: number }
      properties?: { name?: string, regionCode?: string, region?: string, country?: string, countryName?: string }
    }>

    const match = results.find((result) => {
      const place = result.properties ?? {}
      if (agrees(place, hint))
        return true
      // "Munich, Bayern": the gazetteer says Bavaria, so the hint cannot
      // agree, but the city is named exactly. A two-letter hint is a code,
      // though, and a code that disagrees is a different place — Portland,
      // ME is not Portland, OR.
      return hint.length > 3 && String(place.name ?? '').trim().toLowerCase() === city
    })
    const lat = Number(match?.center?.lat)
    const lng = Number(match?.center?.lng)
    return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null
  }
  catch {
    return null
  }
}

/** Whether a result is in the place named after the comma. No hint, no check. */
export function agrees(
  place: { regionCode?: string, region?: string, country?: string, countryName?: string },
  hint: string,
): boolean {
  if (!hint)
    return true

  const said = hint.toLowerCase()
  const known = [place.regionCode, place.country, place.region, place.countryName]
    .map(value => String(value ?? '').trim().toLowerCase())
    .filter(Boolean)

  // "CA" must equal a code; a longer hint may name the region or country.
  return said.length <= 3
    ? known.includes(said)
    : known.some(value => value.length > 3 && (value === said || said.includes(value) || value.includes(said)))
}

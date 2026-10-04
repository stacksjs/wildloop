import { openGazetteer } from './gazetteer'

export interface PlacePoint {
  lat: number
  lng: number
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

import type { PhotoCandidate } from './trailPhotoCandidates'
import type { TrailPlaceFields } from './placeText'
import { creditText } from './commonsCredit'
import { searchPlaces } from './placeText'
import { distinctiveWords, plainText } from './trailPhotoCandidates'

/**
 * The second way to find a photograph of a trail: ask Commons for files
 * named after it.
 *
 * The geosearch (trailPhotoCandidates.ts) only sees files whose camera was
 * within a few kilometres of the trail head, and a great many good ones have
 * no location at all, or were taken from the summit, or of the arch the trail
 * climbs to from the far end. This searches by the trail's name instead,
 * narrowed by the places it lies in (placeText.ts `searchPlaces`), and then
 * holds every answer to the same standard the geosearch is held to by
 * construction:
 *
 * - The title names the trail: every word of the searched name is in it.
 * - A file with coordinates — where the camera stood, or what it shows —
 *   has one within `NAME_SEARCH_RADIUS_METRES` of the trail. Commons search
 *   is generous: `intitle:"Cathedral Rock"` also returns the Rock of Cashel's
 *   cathedral, in Ireland, and its coordinates are how it is refused.
 * - A file with no coordinates says where it is: one of the trail's places
 *   appears in its title, description or categories. With no place known,
 *   such a file has no evidence at all and is not offered.
 *
 * What passes is still only a candidate. The licence rule is applied where
 * every candidate is stored (trailPhotoQueue.ts `storeCandidates`), and a
 * person decides on /admin/photos.
 */

/** Metres from the trail — its line's box, or its head — that a located file may be. */
export const NAME_SEARCH_RADIUS_METRES = 5000

/** Results asked for per trail. Enough for a famous trail's best, not its whole category. */
export const NAME_SEARCH_LIMIT = 50

/** Words that end a trail's name without naming anywhere: "Cathedral Rock Trail". */
const GENERIC_ENDINGS = new Set(['trail', 'trails', 'loop', 'path', 'route', 'hike', 'trailhead', 'track', 'walk', 'weg', 'wanderweg', 'rundweg', 'steig'])

/** Lowercase, accents gone, anything but letters and digits a space. */
export function foldText(text: unknown): string {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * The part of a trail's name a photographer would title a picture with, or ''
 * when it is too plain to search for.
 *
 * Long names are two places joined: "Half Dome via the Mist Trail" is
 * searched as "Half Dome", the place the walk is for. A trailing "Trail" or
 * "Loop" goes when two words are left without it ("Cathedral Rock"), and
 * stays when it would leave one ("Mist Trail" — "Mist" alone is weather). A
 * single word, or a name of nothing but generic words, is not searched:
 * "Equestrian" or "Loop Trail" would bring back every one in the world.
 */
export function searchName(trailName: unknown): string {
  const first = String(trailName ?? '')
    .split(/\s+(?:to|via|and|&|from|over|und|nach|über)\s+|\s+[–—-]\s+|\s*[(,:;/]/i)[0] ?? ''
  const words = first.replace(/^\s*the\s+/i, '').split(/\s+/).filter(Boolean)

  while (words.length > 2 && GENERIC_ENDINGS.has(foldText(words.at(-1))))
    words.pop()

  const phrase = words.join(' ').replace(/["“”]/g, '').trim()
  const folded = foldText(phrase).split(' ').filter(Boolean)
  if (folded.length < 2 || distinctiveWords(phrase).length === 0)
    return ''
  return phrase
}

/** The catalog fields a name search needs: where the trail is, and what it is called. */
export interface NameSearchTrail extends TrailPlaceFields {
  name: string
  latitude: number
  longitude: number
  min_lat?: number | null
  max_lat?: number | null
  min_lng?: number | null
  max_lng?: number | null
}

export interface NameSearchPlan {
  /** Searched in file titles as a phrase. */
  phrase: string
  /** Any one of these, somewhere on the file page. */
  places: string[]
}

/** What to ask Commons for this trail, or null when its name is too plain to search. */
export function nameSearchPlan(trail: NameSearchTrail): NameSearchPlan | null {
  const phrase = searchName(trail.name)
  if (!phrase)
    return null
  return { phrase, places: searchPlaces(trail) }
}

/** A place as a search term: one word bare, more in quotes. */
function term(place: string): string {
  const clean = place.replace(/["“”]/g, '').trim()
  return /\s/.test(clean) ? `"${clean}"` : clean
}

/**
 * The Commons search for one plan: files (namespace 6) that are pictures,
 * whose titles carry the phrase, mentioning any one of the places. With the
 * licence, author and description for each, and every coordinate it has —
 * `coprimary=all` takes the location of what is shown as well as where the
 * camera stood.
 */
export function commonsNameSearchUrl(plan: NameSearchPlan, limit = NAME_SEARCH_LIMIT): string {
  const query = [`intitle:"${plan.phrase.replace(/["“”]/g, '')}"`]
  if (plan.places.length > 0)
    query.push(plan.places.map(term).join(' OR '))
  query.push('filetype:bitmap')

  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'search',
    gsrsearch: query.join(' '),
    gsrnamespace: '6',
    gsrlimit: String(Math.max(1, Math.min(50, Math.round(limit)))),
    prop: 'imageinfo|coordinates',
    iiprop: 'url|extmetadata',
    iiurlwidth: '960',
    iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|ImageDescription|ObjectName|Categories|GPSLatitude|GPSLongitude',
    coprimary: 'all',
    colimit: 'max',
  })
  return `https://commons.wikimedia.org/w/api.php?${params}`
}

interface Point {
  lat: number
  lng: number
}

const EARTH_RADIUS_METRES = 6_371_000

function metresBetween(a: Point, b: Point): number {
  const rad = Math.PI / 180
  const h = Math.sin(((b.lat - a.lat) * rad) / 2) ** 2
    + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(((b.lng - a.lng) * rad) / 2) ** 2
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(h)))
}

const finite = (value: unknown): value is number => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value))

/**
 * Metres from a point to the trail: to the nearest edge of its line's
 * bounding box when the catalog has one (nothing inside it), otherwise to its
 * head. A box is generous for a trail that bends, which is the side to err on
 * for a list a person reads.
 */
export function metresFromTrail(point: Point, trail: NameSearchTrail): number {
  const box = [trail.min_lat, trail.max_lat, trail.min_lng, trail.max_lng]
  if (box.every(finite)) {
    const [minLat, maxLat, minLng, maxLng] = box.map(Number) as [number, number, number, number]
    if (minLat <= maxLat && minLng <= maxLng) {
      const nearest = {
        lat: Math.min(maxLat, Math.max(minLat, point.lat)),
        lng: Math.min(maxLng, Math.max(minLng, point.lng)),
      }
      return metresBetween(point, nearest)
    }
  }
  return metresBetween(point, { lat: Number(trail.latitude), lng: Number(trail.longitude) })
}

/** Every coordinate Commons gave for a file: its coordinates list, else the EXIF position. */
function fileCoordinates(page: any): Point[] {
  const listed = (Array.isArray(page?.coordinates) ? page.coordinates : [])
    .map((entry: any) => ({ lat: Number(entry?.lat), lng: Number(entry?.lon ?? entry?.lng) }))
    .filter((point: Point) => Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180)
  if (listed.length > 0)
    return listed

  const meta = page?.imageinfo?.[0]?.extmetadata ?? {}
  const lat = Number.parseFloat(plainText(meta?.GPSLatitude?.value))
  const lng = Number.parseFloat(plainText(meta?.GPSLongitude?.value))
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [{ lat, lng }] : []
}

/** Whether folded text carries a folded phrase as whole words. */
function mentions(haystack: string, phrase: string): boolean {
  const needle = foldText(phrase)
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `)
}

/**
 * Turn a Commons search answer into candidates for one trail, under the
 * rules at the top of this file. Located files come first, nearest first;
 * then the unlocated ones, by title.
 */
export function candidatesFromNameSearch(
  payload: unknown,
  trail: NameSearchTrail,
  plan: NameSearchPlan | null = nameSearchPlan(trail),
  radiusMetres = NAME_SEARCH_RADIUS_METRES,
): PhotoCandidate[] {
  const pages = (payload as any)?.query?.pages
  if (!plan || !pages || typeof pages !== 'object')
    return []

  const phraseWords = foldText(plan.phrase).split(' ').filter(word => word.length > 1)
  const shown = distinctiveWords(plan.phrase)
  const found: PhotoCandidate[] = []

  for (const page of Object.values(pages) as any[]) {
    const title = String(page?.title ?? '').replace(/^File:/i, '')
    const titleWords = ` ${foldText(title)} `
    if (phraseWords.length === 0 || !phraseWords.every(word => titleWords.includes(` ${word} `) || titleWords.includes(` ${word}s `)))
      continue

    const info = (page?.imageinfo ?? [])[0]
    const meta = info?.extmetadata ?? {}
    const license = plainText(meta?.LicenseShortName?.value)
    if (!license)
      continue

    let distanceMetres: number | null = null
    const points = fileCoordinates(page)
    if (points.length > 0) {
      distanceMetres = Math.min(...points.map(point => metresFromTrail(point, trail)))
      if (distanceMetres > radiusMetres)
        continue
    }
    else {
      const about = foldText([
        title,
        plainText(meta?.ObjectName?.value),
        plainText(meta?.ImageDescription?.value),
        String(meta?.Categories?.value ?? '').replace(/\|/g, ' '),
      ].join(' '))
      if (!plan.places.some(place => mentions(about, place)))
        continue
    }

    found.push({
      title,
      url: String(info?.thumburl ?? info?.url ?? ''),
      pageUrl: String(info?.descriptionurl ?? ''),
      credit: creditText(meta?.Artist?.value) || 'Unknown',
      license,
      licenseUrl: plainText(meta?.LicenseUrl?.value),
      matched: shown.length > 0 ? shown : phraseWords,
      foundBy: 'name',
      distanceMetres: distanceMetres === null ? null : Math.round(distanceMetres),
    })
  }

  return found.sort((a, b) => {
    const da = a.distanceMetres ?? Number.POSITIVE_INFINITY
    const db = b.distanceMetres ?? Number.POSITIVE_INFINITY
    return da - db || a.title.localeCompare(b.title)
  })
}

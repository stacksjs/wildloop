/**
 * Finding real photographs for the trails people actually open.
 *
 * The catalog carries 596,556 trails and a stock Unsplash picture on most of
 * them, labelled "Illustrative photo" — honest, and an admission on every page
 * (#1006). Sourcing a real photo for all of them is not a project; sourcing
 * one for the handful anybody opens is an afternoon.
 *
 * What this does NOT do is write a photo onto a trail. A geosearch around Mist
 * Trail's coordinates returns, in order: a dogwood flower, four pine trees,
 * and a film poster. Proximity says a photograph was taken near a trail, never
 * that it is a photograph OF the trail, and `curatedTrailPhotos.ts` says so in
 * its own header — every entry there was checked by a person against the file
 * page. This narrows the search from "all of Commons" to a short list whose
 * titles name the trail, carries the licence and author through, and leaves
 * the judgement where it already lives.
 */

/** Words that say nothing about which trail a file depicts. */
const STOP_WORDS = new Set([
  'trail', 'trails', 'the', 'to', 'and', 'of', 'via', 'loop', 'path',
  'track', 'route', 'national', 'state', 'park', 'forest', 'area',
])

export interface PhotoCandidate {
  title: string
  /** The file itself, at a width the card can use. */
  url: string
  /** Commons file page — the licence's required attribution link. */
  pageUrl: string
  credit: string
  license: string
  licenseUrl: string
  /** How many of the trail's distinctive words the title carries. */
  matched: string[]
}

/**
 * The words from a trail's name worth matching a file title against.
 *
 * "Mist Trail to Vernal Fall" reduces to mist, vernal, fall — three words a
 * photographer would plausibly put in a caption. Keeping "trail" would match
 * every trail photograph in the world, which is the same as matching none.
 */
export function distinctiveWords(name: string): string[] {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(word => word.length > 2 && !STOP_WORDS.has(word))
}

/**
 * Whether a file title plausibly depicts this trail.
 *
 * Two distinctive words, or the only one a short name has.
 *
 * Requiring every word was the first rule and it was too strict to be useful:
 * a trail named "Bright Angel Trail to Three-Mile Resthouse" demanded five
 * words in one caption, and nine of the engaged trails produced one candidate
 * between them. Long names are usually two places joined by "via" or "to", and
 * a photographer titles a picture after the one they were standing on.
 *
 * One word is still refused, because one word is how a namesake trail inherits
 * somebody else's scenery. Geography does most of this work anyway — the
 * search is already confined to a few kilometres of the trail head — and what
 * comes out is a list for somebody to look at, not a photo to publish, so the
 * cost of an extra candidate is a glance and the cost of a missing one is a
 * stock photograph that stays.
 */
export const MIN_MATCHED_WORDS = 2

export function titleNamesTrail(title: string, trailName: string): string[] {
  const words = distinctiveWords(trailName)
  if (words.length === 0)
    return []

  const haystack = String(title ?? '').toLowerCase()
  const matched = words.filter(word => haystack.includes(word))

  const needed = Math.min(MIN_MATCHED_WORDS, words.length)
  return matched.length >= needed ? matched : []
}

/** Strips the HTML Commons returns in its `Artist` and licence fields. */
export function plainText(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The Commons geosearch URL for one trail head. */
export function commonsGeosearchUrl(lat: number, lng: number, radiusMetres: number, limit = 200): string {
  const params = new URLSearchParams({
    action: 'query',
    format: 'json',
    generator: 'geosearch',
    ggscoord: `${lat}|${lng}`,
    ggsradius: String(Math.max(10, Math.min(10_000, Math.round(radiusMetres)))),
    ggslimit: String(limit),
    // Namespace 6 is File:. Anything else is an article that happens to have
    // coordinates.
    ggsnamespace: '6',
    prop: 'imageinfo',
    iiprop: 'url|extmetadata',
    iiurlwidth: '960',
  })
  return `https://commons.wikimedia.org/w/api.php?${params}`
}

/**
 * Turn a Commons response into candidates whose titles name the trail.
 *
 * A file with no licence recorded is dropped rather than carried with an empty
 * field: the whole point of sourcing from Commons rather than from a search
 * engine is that the terms travel with the picture.
 */
export function candidatesFrom(payload: unknown, trailName: string): PhotoCandidate[] {
  const pages = (payload as any)?.query?.pages
  if (!pages || typeof pages !== 'object')
    return []

  const found: PhotoCandidate[] = []
  for (const page of Object.values(pages) as any[]) {
    const title = String(page?.title ?? '').replace(/^File:/i, '')
    const matched = titleNamesTrail(title, trailName)
    if (matched.length === 0)
      continue

    const info = (page?.imageinfo ?? [])[0]
    const meta = info?.extmetadata ?? {}
    const license = plainText(meta?.LicenseShortName?.value)
    if (!license)
      continue

    found.push({
      title,
      url: String(info?.thumburl ?? info?.url ?? ''),
      pageUrl: String(info?.descriptionurl ?? ''),
      credit: plainText(meta?.Artist?.value) || 'Unknown',
      license,
      licenseUrl: plainText(meta?.LicenseUrl?.value),
      matched,
    })
  }

  // Most specific first: a title carrying more of the trail's words is more
  // likely to be the trail rather than the valley it sits in.
  return found.sort((a, b) => b.matched.length - a.matched.length || a.title.localeCompare(b.title))
}

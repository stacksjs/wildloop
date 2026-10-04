/**
 * Ranking the trails around somebody.
 *
 * "Near me" used to be a bounding box ordered the way the national catalog
 * is: length band, then rating, then the longest route. Nothing in that order
 * knows where the visitor is, and the rating is zero on every row, so in
 * practice it was "the longest trails in a 50-mile square". From Santa Monica
 * that opened on Upper Pacoima Canyon, 25 miles away in the San Gabriels,
 * with Temescal Canyon — four miles away and one of the most-walked trails in
 * the city — nowhere on the first screen.
 *
 * A trail app answers "what should I do near here" with two things at once:
 * how close a trail is and how good it is. This is that, as one number.
 *
 *   score = appeal × proximity
 *
 * Appeal is everything known about a trail that says people go there:
 * reviews, saves and completions first, because those are the real thing, and
 * until there are enough of them, what the catalog row itself gives away. A
 * name ending in "Falls" or "Peak" is somewhere people set out for; "Edison
 * Road" and "4N35" are how the map gets from one of those to another; a
 * "Proposed" or "-UNMAINTAINED-" trail is one nobody should be sent down.
 *
 * Proximity decays smoothly with distance rather than cutting off, so a
 * famous trail ten miles away can still beat a fire road at the end of the
 * street, but not one forty miles away.
 *
 * Kept in plain TypeScript rather than a SQL expression: word lists are far
 * easier to test as code than as a page of `LIKE` clauses, and the candidate
 * set it ranks is a bounding box — about 2,200 rows around Los Angeles and
 * under 4,000 around Munich, the densest place in the catalog.
 */

/** The columns ranking reads. Everything else is fetched for the page only. */
export const RANK_COLUMNS = [
  'id',
  'name',
  'location',
  'source',
  'distance',
  'rating',
  'review_count',
  'national_trail',
  'latitude',
  'longitude',
  // Read by `tasteFit` only.
  'difficulty',
  'route_type',
] as const

export interface RankableTrail {
  id: number
  name?: string | null
  location?: string | null
  source?: string | null
  distance?: number | null
  rating?: number | null
  review_count?: number | null
  national_trail?: unknown
  latitude?: number | null
  longitude?: number | null
  difficulty?: string | null
  route_type?: string | null
}

/** What Wildloop's own athletes have done with a trail. */
export interface TrailActivity {
  saves: number
  completions: number
  photos: number
}

export interface Origin {
  lat: number
  lng: number
}

/**
 * How a ranked list is ordered.
 *
 * - `best`: appeal and proximity together. What a trail app means by "best
 *   match" once it knows where you are.
 * - `popular`: what people actually do, with proximity as the tiebreak.
 * - `rating`: reviews first, best match after that.
 * - `nearest`: closest first, whatever it is — with fragments and junk still
 *   kept out of the way, since "closest" never means "closest unnamed spur".
 * - `recommended`: best match, weighted toward the kind of trail somebody
 *   already likes (`tasteFit`). Without a taste to go on it is best match.
 */
export type RankMode = 'best' | 'popular' | 'rating' | 'nearest' | 'recommended'

export interface RankedTrail<T extends RankableTrail = RankableTrail> {
  trail: T
  /** Straight-line miles from the origin to the trail's start. */
  milesAway: number
  score: number
}

const MILES_PER_DEGREE = 69

/**
 * Below this, a row is not worth a trip on its own: a short way with nothing
 * remarkable in its name (0.41), a path along a boulevard (0.45), a code, a
 * proposed trail. An ordinary named 1-mile path from OpenStreetMap is 0.9.
 */
const WORTH_A_TRIP = 0.5

/** Miles from the origin, flat-earth. At the radii ranked here the error is noise. */
export function milesBetween(origin: Origin, lat: number, lng: number): number {
  const dLat = (lat - origin.lat) * MILES_PER_DEGREE
  const dLng = (lng - origin.lng) * MILES_PER_DEGREE * Math.cos((origin.lat * Math.PI) / 180)
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

/**
 * How much distance costs, as a weight from 1 down toward 0.
 *
 * Half weight at `scale` miles. The scale follows the radius, because "near"
 * is relative: inside a 25-mile search a trail 15 miles out — half an hour's
 * drive, which people make for a good hike — is half as near as one next
 * door, but a search that had to widen to 150 miles to find anything is
 * somewhere sparse, and the trail 90 miles away is the local one.
 */
export function proximityWeight(milesAway: number, radiusMiles: number): number {
  const scale = Math.min(180, Math.max(6, radiusMiles * 0.6))
  const ratio = milesAway / scale
  return 1 / (1 + ratio * ratio)
}

/*
 * Name signals.
 *
 * Matched as whole words, case-insensitively. Each list is applied once, at
 * its strongest match, so "Peak Ridge Canyon Loop" is not four times as good
 * as "Peak".
 */

/** Somewhere a person sets out for. */
const DESTINATION_WORDS = [
  'falls', 'fall', 'waterfall', 'cascade', 'cascades', 'peak', 'summit', 'lake', 'lakes', 'arch',
  'overlook', 'lookout', 'observatory', 'hot springs', 'glacier', 'tarn',
]

/** Somewhere worth walking, if not a destination on its own. */
const SCENIC_WORDS = [
  'canyon', 'ridge', 'loop', 'point', 'vista', 'view', 'views', 'cove', 'beach', 'bluff', 'bluffs',
  'cave', 'caves', 'spring', 'springs', 'meadow', 'meadows', 'grove', 'mount', 'mt', 'mountain',
  'dome', 'butte', 'mesa', 'crags', 'gorge', 'creek', 'river', 'rim', 'notch', 'pass', 'nature',
  'scenic', 'sunset', 'sunrise', 'redwood', 'redwoods', 'wildflower', 'garden', 'gardens',
]

/**
 * How the map connects one trail to another. Real paths, rarely a day out.
 * "Fire road" and "truck trail" are phrases: "trail" alone is not a penalty.
 */
const CONNECTOR_WORDS = [
  'road', 'rd', 'motorway', 'truck trail', 'fire road', 'fireroad', 'firebreak', 'fuel break',
  'fuelbreak', 'bikeway', 'bike path', 'bike route', 'connector', 'connection', 'spur', 'access',
  'service', 'utility', 'powerline', 'power line', 'easement', 'sidewalk', 'parking', 'driveway',
  'cutoff', 'cut-off', 'shortcut', 'bypass', 'horse path', 'alley', 'right of way', 'levee',
  'channel', 'aqueduct', 'pipeline', 'segment', 'detour', 'jeep', 'ohv', '4wd', 'atv',
  // Streets: a path along one is a sidewalk with a name.
  'street', 'st', 'avenue', 'ave', 'boulevard', 'blvd', 'drive', 'highway', 'hwy', 'freeway',
  'median', 'parkway', 'pkwy', 'lane', 'ln', 'promenade', 'plaza', 'mall', 'pier', 'marina',
  'campus', 'boardwalk',
]

/** A trail nobody should be sent down, whatever else its name says. */
const UNFIT_WORDS = [
  'proposed', 'planned', 'test', 'unmaintained', 'abandoned', 'closed', 'decommissioned',
  'obliterated', 'private', 'no access', 'unofficial', 'informal', 'social trail', 'temporary',
  'construction', 'removed', 'do not use', 'restricted',
]

function wordPattern(words: string[]): RegExp {
  const escaped = words
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '[\\s_-]+'))
  // \p{L}\p{N} rather than \b, so "Zürich" and "Höhenweg" are not split at the umlaut.
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${escaped.join('|')})(?![\\p{L}\\p{N}])`, 'iu')
}

const DESTINATION = wordPattern(DESTINATION_WORDS)
const SCENIC = wordPattern(SCENIC_WORDS)
const CONNECTOR = wordPattern(CONNECTOR_WORDS)
const UNFIT = wordPattern(UNFIT_WORDS)

/**
 * A designation rather than a name: Forest Service road numbers ("4N35",
 * "2N04"), bare numbers, and OSM's "Trail 1W03"-style refs. Nobody plans a
 * Saturday around one.
 */
const CODE_NAME = /^(?:(?:trail|route|road|tr|fr|nf|fs)\s*)?[#-]?\s*\d+[a-z]?\d*(?:[.-]\d+[a-z]?)?(?:\s*(?:trail|tr|road|rd))?$/i
const FS_CODE = /^\d{1,2}[nsew]\d{1,3}[a-z]?\b/i

/** A placeholder a mapper left where a name should be. */
const UNNAMED = /^(?:unnamed|untitled|unknown|no name|path|trail|footpath|track)\b/i

/** A location that names a place rather than only a state: a park, a forest. */
const NAMED_PLACE = /\b(?:national|state|regional|county|city|park|forest|preserve|reserve|recreation|wilderness|monument|conservancy|open space|naturpark|nationalpark)\b/i

/** Every word-based judgement of a name, as one multiplier. Exported for tests. */
export function nameAppeal(name: string | null | undefined): number {
  const text = String(name ?? '').trim()
  if (!text)
    return 0.3

  if (UNFIT.test(text))
    return 0.12

  if (CODE_NAME.test(text) || FS_CODE.test(text) || UNNAMED.test(text))
    return 0.35

  let factor = 1
  if (DESTINATION.test(text))
    factor *= 1.5
  else if (SCENIC.test(text))
    factor *= 1.2

  // A road to a peak is still a road, but it gets you to a peak: the two
  // signals combine rather than one cancelling the other.
  if (CONNECTOR.test(text))
    factor *= 0.5

  return factor
}

/** How well a trail's length suits a day out. Mirrors `browse_band`, with a peak in the middle. */
export function lengthAppeal(miles: number | null | undefined): number {
  const d = Number(miles)
  if (!Number.isFinite(d) || d <= 0)
    return 0.1
  if (d >= 2 && d <= 9)
    return 1.15
  if (d >= 1 && d <= 15)
    return 1
  if (d >= 0.4 && d <= 30)
    return 0.45
  return 0.12
}

const SOURCE_APPEAL: Record<string, number> = {
  // Hand-entered: every one was put there by a person on purpose.
  manual: 1.25,
  // Drawn and named by the park that manages it.
  nps: 1.15,
  usfs: 1,
  osm: 0.9,
}

/** The prior a rating is shrunk toward, so one five-star review is not a five-star trail. */
const PRIOR_RATING = 3.8
const PRIOR_WEIGHT = 2

/**
 * What reviews say, as a multiplier. 1 for an unreviewed trail, so having no
 * reviews costs nothing while nobody has any.
 */
export function ratingAppeal(rating: number | null | undefined, reviews: number | null | undefined): number {
  const n = Math.max(0, Number(reviews) || 0)
  const r = Number(rating) || 0
  if (n === 0 || r <= 0)
    return 1
  const shrunk = (r * n + PRIOR_RATING * PRIOR_WEIGHT) / (n + PRIOR_WEIGHT)
  return (shrunk / PRIOR_RATING) ** 2
}

/**
 * What people do, as a multiplier: reviews, saves, completions and photos.
 *
 * Logarithmic, because the tenth person to walk a trail says much less than
 * the first, and a trail with a hundred completions should not bury every
 * other trail in the county.
 */
export function engagementAppeal(reviews: number | null | undefined, activity?: TrailActivity): number {
  const signal = (Number(reviews) || 0)
    + (activity?.saves ?? 0)
    + 2 * (activity?.completions ?? 0)
    + (activity?.photos ?? 0)
  return 1 + 0.6 * Math.log2(1 + Math.max(0, signal))
}

/**
 * Everything known about a trail that says people go there, independent of
 * where the visitor is.
 */
export function trailAppeal(trail: RankableTrail, activity?: TrailActivity): number {
  const source = SOURCE_APPEAL[String(trail.source ?? '').toLowerCase()] ?? 1
  const place = NAMED_PLACE.test(String(trail.location ?? '')) ? 1.1 : 1
  const national = Number(trail.national_trail) ? 1.1 : 1

  return nameAppeal(trail.name)
    * lengthAppeal(trail.distance)
    * source
    * place
    * national
    * ratingAppeal(trail.rating, trail.review_count)
    * engagementAppeal(trail.review_count, activity)
}

/**
 * The kind of trail somebody likes, from the trails they saved or did.
 *
 * Deliberately small: how long, how hard, and whether they come back to where
 * they started. Those three are what a trail app's "you may like" is mostly
 * made of, they are on every catalog row, and they can be read off a handful
 * of trails without pretending to know more than that.
 */
export interface TasteProfile {
  /** How many trails the profile was read from. */
  basis: number
  /** Median length, miles. */
  medianMiles: number
  /** Share of each grade, 0–1. */
  difficulty: Record<string, number>
  /** Share of loops among the trails whose route type is known, or null. */
  loopShare: number | null
}

/** Fewer trails than this say too little about a taste to steer by it. */
const MIN_TASTE_BASIS = 2

export function tasteProfile(trails: Pick<RankableTrail, 'distance' | 'difficulty' | 'route_type'>[]): TasteProfile | null {
  const lengths = trails
    .map(trail => Number(trail.distance))
    .filter(miles => Number.isFinite(miles) && miles > 0)
    .sort((a, b) => a - b)

  if (lengths.length < MIN_TASTE_BASIS)
    return null

  const middle = Math.floor(lengths.length / 2)
  const medianMiles = lengths.length % 2 ? lengths[middle] : (lengths[middle - 1] + lengths[middle]) / 2

  const difficulty: Record<string, number> = {}
  const graded = trails.filter(trail => trail.difficulty)
  for (const trail of graded)
    difficulty[String(trail.difficulty)] = (difficulty[String(trail.difficulty)] ?? 0) + 1 / graded.length

  const routed = trails.filter(trail => trail.route_type)
  const loopShare = routed.length > 0
    ? routed.filter(trail => trail.route_type === 'loop').length / routed.length
    : null

  return { basis: lengths.length, medianMiles, difficulty, loopShare }
}

/**
 * How well a trail suits a taste, as a multiplier around 1.
 *
 * Length is compared in ratios, not miles: 3 miles against a taste for 6 is
 * as far off as 12 is. Grades nobody has done yet are discounted, never
 * excluded — the first moderate hike is how somebody stops only doing easy
 * ones. Every factor is bounded, so a taste steers the list without being
 * able to empty it of the trails that are simply better.
 */
export function tasteFit(trail: RankableTrail, taste: TasteProfile | null): number {
  if (!taste)
    return 1

  const miles = Number(trail.distance)
  // 1 at the median, about 0.6 at double or half, never below 0.35.
  const lengthFit = Number.isFinite(miles) && miles > 0
    ? Math.max(0.35, Math.exp(-(Math.log(miles / taste.medianMiles) ** 2) / (2 * 0.6 ** 2)))
    : 0.5

  const grade = String(trail.difficulty ?? '')
  const gradeFit = 0.6 + 0.8 * (taste.difficulty[grade] ?? 0)

  const loopFit = taste.loopShare === null || !trail.route_type
    ? 1
    : trail.route_type === 'loop' ? 0.85 + 0.3 * taste.loopShare : 1.15 - 0.3 * taste.loopShare

  return lengthFit * gradeFit * loopFit
}

/**
 * The name two rows must share to be the same trail.
 *
 * A parenthetical is a note about the trail, not its name: "Eagle Rock Fire
 * Road (Backbone Trail)" is the fire road. Punctuation and case are noise
 * from the source.
 */
export function sameTrailKey(name: string | null | undefined): string {
  return String(name ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    // "Sam Merrill Trail" and "Sam Merrill" are one trail named twice.
    .replace(/\b(?:trail|tr)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * How far apart two same-named rows can start and still be one trail.
 *
 * The catalog holds one trail as several rows: a Forest Service record and
 * the OpenStreetMap ways for the same path, or one path cut into pieces at
 * every junction. "Condor Peak Trail" arrives twice, 0.6 miles apart. Two
 * trails sharing a name three miles apart are, in practice, the same trail
 * seen twice; "Red Trail" in two different parks is not three miles apart.
 */
const SAME_TRAIL_MILES = 3

/**
 * Rank a candidate set around an origin, best first, one row per trail.
 *
 * Rows without coordinates are dropped: a trail that cannot be placed cannot
 * be near anything. Ties break on id, so two pages of one list never disagree
 * about which trail is 60th.
 */
export function rankTrails<T extends RankableTrail>(
  trails: T[],
  origin: Origin,
  radiusMiles: number,
  mode: RankMode = 'best',
  activity: Map<number, TrailActivity> = new Map(),
  taste: TasteProfile | null = null,
): RankedTrail<T>[] {
  const candidates: (RankedTrail<T> & { appeal: number })[] = []

  for (const trail of trails) {
    const lat = Number(trail.latitude)
    const lng = Number(trail.longitude)
    if (!Number.isFinite(lat) || !Number.isFinite(lng))
      continue

    const milesAway = milesBetween(origin, lat, lng)
    const usage = activity.get(Number(trail.id))
    const appeal = trailAppeal(trail, usage)
    const near = proximityWeight(milesAway, radiusMiles)

    let score: number
    switch (mode) {
      case 'nearest':
        // Closest first, literally — but a row not worth the trip (a short
        // unremarkable way, an unnamed spur, a proposed trail) goes behind
        // every real one, since "closest" never means "closest fragment".
        score = -(milesAway + (appeal < WORTH_A_TRIP ? 10_000 : 0))
        break
      case 'popular':
        score = engagementAppeal(trail.review_count, usage) * 1000 + appeal * near
        break
      case 'rating':
        score = (Number(trail.review_count) > 0 ? ratingAppeal(trail.rating, trail.review_count) * 1000 : 0) + appeal * near
        break
      case 'recommended':
        score = appeal * near * tasteFit(trail, taste)
        break
      default:
        score = appeal * near
    }

    candidates.push({ trail, milesAway, score, appeal })
  }

  const byId = (a: RankedTrail<T>, b: RankedTrail<T>) => Number(a.trail.id) - Number(b.trail.id)

  // One row per trail, chosen by appeal whatever the list is sorted by: the
  // piece kept is the park's own record, or the whole trail rather than a
  // fragment of it. Choosing in sort order instead would make "closest" keep
  // whichever fragment happens to start nearest — a 0.4-mile stub of Rivas
  // Canyon in place of the 2-mile trail.
  candidates.sort((a, b) => b.appeal - a.appeal || byId(a, b))

  const kept: RankedTrail<T>[] = []
  const seen = new Map<string, Origin[]>()

  for (const { trail, milesAway, score } of candidates) {
    const key = sameTrailKey(trail.name)
    const here = { lat: Number(trail.latitude), lng: Number(trail.longitude) }

    if (key) {
      const starts = seen.get(key)
      if (starts?.some(start => milesBetween(start, here.lat, here.lng) <= SAME_TRAIL_MILES))
        continue
      if (starts)
        starts.push(here)
      else
        seen.set(key, [here])
    }

    kept.push({ trail, milesAway, score })
  }

  // Ties break on id, so two pages of one list never disagree about which
  // trail is 60th.
  return kept.sort((a, b) => b.score - a.score || byId(a, b))
}

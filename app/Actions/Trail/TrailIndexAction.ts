import { readPageParams } from '../../../resources/functions/pagination'
import { visitorCountry } from '../../Helpers/visitorCountry'

const DIFFICULTIES = new Set(['easy', 'moderate', 'hard'])
const ROUTE_TYPES = new Set(['loop', 'out-and-back', 'point-to-point', 'network'])
const SOURCES = new Set(['osm', 'usfs', 'nps', 'manual'])
const SORTS = new Set(['featured', 'distance', 'longest', 'rating', 'name'])

/** Degrees of latitude per mile. Longitude is narrowed by cos(lat) at use. */
const DEGREES_PER_MILE = 1 / 69

/** Default "near me" radius, in miles. */
const DEFAULT_RADIUS = 25

/** Hard ceiling, so a hand-written `?radius=99999` cannot ask for a table scan. */
const MAX_RADIUS = 300

/**
 * Enough results for a page to be worth showing. Below this a "near me" search
 * widens instead of rendering an empty state the visitor cannot act on.
 */
const MIN_NEARBY_RESULTS = 12

/** Radii to try, in order, when the requested one is too thin. */
const WIDER_RADII = [60, 150, MAX_RADIUS]

/**
 * List trails for the explore map and catalog.
 *
 * Every filter, the ordering and the page window are pushed into SQL. That is
 * not premature optimization: the catalog is fed by a national ingest and the
 * table holds tens of thousands of rows today on its way to millions. The
 * previous implementation called `Trail.all()` and sliced the result in
 * JavaScript, which meant every request to this endpoint deserialized the
 * entire table — geometry strings included — to return 500 rows. Two indexes
 * added with those columns (`trails_state_index`, `trails_bbox_index`) exist
 * precisely so this query does not have to scan.
 */
export default new Action({
  name: 'Trail Index',
  description: 'List trails for the explore map and catalog',
  method: 'GET',

  async handle(request) {
    const page = readPageParams(request, { defaultLimit: 200, maxLimit: 500 })
    const origin = readOrigin(request)

    try {
      // Built twice: once to count the matches, once to fetch the window.
      // A count over an indexed predicate is cheap, and it is the only way to
      // give the UI an honest "N trails match" without fetching all of them.
      const fetchPage = async (skipInferredCountry: boolean, radius?: number) => {
        const rows = await applyFilters(Trail.query(), request, skipInferredCountry, radius)
          .orderBy(...sortColumns(request))
          .limit(page.limit)
          .offset(page.offset)
          .get()
        const total = await applyFilters(Trail.query(), request, skipInferredCountry, radius).count()
        return { rows, total }
      }

      let { rows, total } = await fetchPage(false)
      let radius = origin ? requestedRadius(request) : null

      /*
       * "Near me" widens rather than coming back empty.
       *
       * A 25-mile box is generous in the Bay Area and nearly empty in eastern
       * Oregon, and the visitor cannot tell those two cases apart: both render
       * as "no trails found" under a filter they did not set. So the search
       * grows outward until it has enough to show, and the response reports
       * the radius it actually used so the page can say "within 150 miles"
       * instead of quietly answering a different question.
       */
      if (origin && total < MIN_NEARBY_RESULTS) {
        for (const wider of WIDER_RADII) {
          if (wider <= (radius ?? 0))
            continue
          const attempt = await fetchPage(false, wider)
          radius = wider
          rows = attempt.rows
          total = attempt.total
          if (total >= MIN_NEARBY_RESULTS)
            break
        }
      }

      /*
       * An INFERRED country must never be able to empty the page.
       *
       * The catalog covers the US and the DACH countries. Inferring a country
       * from the request means a visitor in London — whose Accept-Language
       * says en-GB perfectly correctly — was filtered down to a country the
       * catalog has no trails in, and got an empty result where before they
       * saw everything. A guess that makes the product worse than no guess is
       * not worth keeping.
       *
       * Only for the inferred case: an explicit `?country=GB` is a question
       * with a real answer of "none", and answering it with the whole catalog
       * would be a lie.
       */
      if (total === 0 && !readString(request, 'country'))
        ({ rows, total } = await fetchPage(true))

      const trails = (rows ?? []).map((row: Record<string, unknown>) => ({
        ...row,
        // The map layer reads `lat`/`lng`; the column names are the long form.
        lat: row.latitude,
        lng: row.longitude,
      }))

      return response.json({
        success: true,
        trails,
        meta: {
          offset: page.offset,
          limit: page.limit,
          total,
          hasMore: page.offset + trails.length < total,
          // Present only for a "near me" query, and only ever the radius the
          // answer was actually computed at.
          ...(radius !== null ? { radius } : {}),
        },
      })
    }
    catch (error) {
      console.error('[trails] index failed:', error)
      return response.json({
        success: false,
        trails: [],
        meta: { offset: 0, limit: 0, total: 0, hasMore: false },
        error: 'Failed to fetch trails',
      }, 500)
    }
  },
})

/**
 * Apply every query-string filter to a builder.
 *
 * Shared by the page query and the count query so the two can never disagree
 * about what "matching" means.
 */
function applyFilters(
  query: any,
  request: { get: (key: string) => any },
  skipInferredCountry = false,
  /** Overrides `?radius=` — set when a "near me" search has widened. */
  radiusOverride?: number,
): any {
  const search = readString(request, 'q') ?? readString(request, 'search')
  if (search) {
    // Matched through the FTS index rather than three `LIKE '%term%'`
    // predicates. Those could not use an index, so every search scanned the
    // whole table — and the exact count, having no LIMIT to stop at, scanned
    // it even for terms that matched nothing.
    //
    // The index covers name, then place (`location` carries the park or
    // forest, so "yosemite" and "pisgah" find their trails even when no trail
    // is named after them) and region.
    const match = toFtsQuery(search)

    // A term that survives sanitising to nothing must match nothing, not
    // everything — dropping the filter would answer "%" with the entire
    // catalog.
    query = match
      ? query.whereRaw('id IN (SELECT rowid FROM trails_fts WHERE trails_fts MATCH ?)', [match])
      : query.whereRaw('1 = 0')
  }

  // An explicit `?country=` always wins. Without one, fall back to where the
  // request appears to come from: a visitor in Munich asking for "popular
  // trails" and getting Colorado reads as the catalog being empty for them,
  // not as the catalog being wrong. Skipped entirely for a coordinate search,
  // which is already more precise than a country and legitimately crosses
  // borders — a bounding box around Basel covers three of them.
  const explicitCountry = readString(request, 'country')
  const hasCoordinates = readOrigin(request) !== null
  const country = explicitCountry ?? (skipInferredCountry || hasCoordinates ? undefined : visitorCountry(request))

  if (country && /^[a-z]{2}$/i.test(country))
    query = query.where('country', country.toUpperCase())

  // Two letters for a US state (`CO`), ISO 3166-2 elsewhere (`DE-BY`). The
  // old two-letter-only pattern silently ignored every DACH region, so
  // `?state=DE-BY` quietly returned the whole catalog instead of Bayern.
  const state = readString(request, 'state')
  if (state && /^[a-z]{2}(?:-[a-z0-9]{1,3})?$/i.test(state))
    query = query.where('state', state.toUpperCase())

  const difficulty = readString(request, 'difficulty')
  if (difficulty && DIFFICULTIES.has(difficulty))
    query = query.where('difficulty', difficulty)

  const routeType = readString(request, 'routeType') ?? readString(request, 'route_type')
  if (routeType && ROUTE_TYPES.has(routeType))
    query = query.where('route_type', routeType)

  const source = readString(request, 'source')
  if (source && SOURCES.has(source))
    query = query.where('source', source)

  const minDistance = readNumber(request, 'minDistance')
  if (minDistance !== null)
    query = query.where('distance', '>=', minDistance)

  const maxDistance = readNumber(request, 'maxDistance')
  if (maxDistance !== null)
    query = query.where('distance', '<=', maxDistance)

  if (readString(request, 'dogsAllowed') === 'true')
    query = query.where('dogs_allowed', true)

  if (readString(request, 'accessible') === 'true')
    query = query.where('wheelchair_accessible', true)

  if (readString(request, 'nationalTrail') === 'true')
    query = query.where('national_trail', true)

  // "Near me": a bounding box, not a radius. It is an index range scan rather
  // than a full-table haversine, and at the zoom a map actually renders the
  // difference between a box and a circle is not visible.
  const origin = readOrigin(request)
  const radius = radiusOverride ?? requestedRadius(request)

  if (origin) {
    const { lat, lng } = origin
    const latSpan = radius * DEGREES_PER_MILE
    // A degree of longitude shrinks toward the poles; without the cosine the
    // box would be far too wide in Alaska and slightly too narrow in Florida.
    const lngSpan = latSpan / Math.max(0.15, Math.cos((lat * Math.PI) / 180))

    query = query
      .where('latitude', '>=', lat - latSpan)
      .where('latitude', '<=', lat + latSpan)
      .where('longitude', '>=', lng - lngSpan)
      .where('longitude', '<=', lng + lngSpan)
  }

  return query
}

/**
 * Default ordering is "featured": National Scenic and Recreation Trails first,
 * then the longest routes. With a catalog this size an unordered page is a
 * random sample of forest service connector spurs, which is a poor first
 * impression of a national trail database.
 */
function sortColumns(request: { get: (key: string) => any }): [string, 'asc' | 'desc'] {
  const sort = readString(request, 'sort')

  switch (sort && SORTS.has(sort) ? sort : 'featured') {
    case 'distance':
      return ['distance', 'asc']
    case 'longest':
      return ['distance', 'desc']
    case 'rating':
      return ['rating', 'desc']
    case 'name':
      return ['name', 'asc']
    default:
      return ['national_trail', 'desc']
  }
}

/**
 * Turn what somebody typed into an FTS5 query.
 *
 * User input cannot be handed to MATCH as-is: `"`, `*`, `:`, `^`, `-`, `(`,
 * `)` and the bare words AND / OR / NOT / NEAR are all query syntax. A trail
 * called "Mont Blanc - Tour" searched verbatim is a syntax error, and a lone
 * `*` is a parse failure rather than a wildcard.
 *
 * So the input is reduced to word tokens, each quoted as a literal. The final
 * token gets a `*` because search runs as you type: without it "Schwarz"
 * matches nothing until the "wald" arrives.
 *
 * Returns null when nothing survives, which the caller turns into "match
 * nothing" rather than "no filter".
 */
function toFtsQuery(input: string): string | null {
  // Unicode-aware: ä, ö, ü and ß are letters here, not separators. The
  // tokenizer folds the diacritics, but only if the character reaches it.
  const tokens = input
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length > 0)
    .slice(0, 8)

  if (tokens.length === 0)
    return null

  return tokens
    .map((token, index) => {
      const quoted = `"${token}"`
      return index === tokens.length - 1 ? `${quoted}*` : quoted
    })
    .join(' ')
}

interface Origin {
  lat: number
  lng: number
}

/** The caller's position, when they gave one. Both halves or neither. */
function readOrigin(request: { get: (key: string) => any }): Origin | null {
  const lat = readNumber(request, 'lat')
  const lng = readNumber(request, 'lng')

  if (lat === null || lng === null || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return null

  return { lat, lng }
}

/** The requested radius, clamped. Miles. */
function requestedRadius(request: { get: (key: string) => any }): number {
  const raw = readNumber(request, 'radius')
  if (raw === null || !(raw > 0))
    return DEFAULT_RADIUS
  return Math.min(raw, MAX_RADIUS)
}

function readString(request: { get: (key: string) => any }, key: string): string | null {
  const raw = request.get(key)
  if (typeof raw !== 'string')
    return null

  const value = raw.trim()
  return value.length > 0 ? value : null
}

function readNumber(request: { get: (key: string) => any }, key: string): number | null {
  const raw = Number(request.get(key))
  return Number.isFinite(raw) ? raw : null
}

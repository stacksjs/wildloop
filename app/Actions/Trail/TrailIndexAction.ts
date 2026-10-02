import { readPageParams } from '../../../resources/functions/pagination'
import { visitorCountry } from '../../Helpers/visitorCountry'
import { withBestTrailCovers } from '../../Support/trailCovers'
import { difficultyIsEstimated } from '../../../resources/functions/trail-difficulty'

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
        const rows = await applyOrder(applyFilters(Trail.query(), request, skipInferredCountry, radius), request)
          .limit(page.limit)
          .offset(page.offset)
          .get()
        const total = await applyFilters(Trail.query(), request, skipInferredCountry, radius).count()
        return { rows, total }
      }

      let { rows, total } = await fetchPage(false)
      let radius = origin ? requestedRadius(request) : null
      // What the answer was actually scoped to. The page shows this as the
      // selected country chip: a list filtered to the US while "Everywhere"
      // is lit is the UI lying about its own state.
      let appliedCountry = resolveCountry(request)

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
      if (total === 0 && !readString(request, 'country')) {
        ({ rows, total } = await fetchPage(true))
        appliedCountry = undefined
      }

      const trails = (await withBestTrailCovers(rows ?? [])).map((row: Record<string, unknown>) => ({
        ...row,
        // The map layer reads `lat`/`lng`; the column names are the long form.
        lat: row.latitude,
        lng: row.longitude,
        /*
         * Whether the grade beside this row is a measurement or distance
         * alone (#1004). Derived from the stored elevation rather than a
         * column of its own, so it corrects itself the moment the elevation
         * backfill reaches a trail.
         *
         * Data, not presentation: the badge's text is built in
         * `trail-data.ts`, which is an allow-list and drops anything it does
         * not name. Both come from the same function in
         * `resources/functions/trail-difficulty.ts`.
         */
        difficultyEstimated: difficultyIsEstimated(row.elevation),
      }))

      return response.json({
        success: true,
        trails,
        meta: {
          offset: page.offset,
          limit: page.limit,
          total,
          hasMore: page.offset + trails.length < total,
          // The country the rows were filtered to, guessed or asked for, and
          // null when they were not filtered at all.
          country: appliedCountry ?? null,
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
        meta: { offset: 0, limit: 0, total: 0, hasMore: false, country: null },
        error: 'Failed to fetch trails',
      }, 500)
    }
  },
})

/**
 * The country this request is answered for, or undefined for the whole catalog.
 *
 * An explicit `?country=` always wins. Without one, fall back to where the
 * request appears to come from: a visitor in Munich asking for "popular
 * trails" and getting Colorado reads as the catalog being empty for them, not
 * as the catalog being wrong. Skipped entirely for a coordinate search, which
 * is already more precise than a country and legitimately crosses borders — a
 * bounding box around Basel covers three of them.
 *
 * `?country=all` is how a caller says "everywhere" out loud. Leaving the
 * parameter off cannot mean that, because an absent country is exactly what
 * turns the guess on: the catalog's four German, Austrian and Swiss trails
 * were unreachable from a US-English browser, which saw 21 of 25 with the
 * "Everywhere" chip lit.
 */
export function resolveCountry(
  request: { get: (key: string) => any },
  skipInferredCountry = false,
): string | undefined {
  const explicit = readString(request, 'country')
  if (explicit)
    return /^[a-z]{2}$/i.test(explicit) ? explicit.toUpperCase() : undefined

  if (skipInferredCountry || readOrigin(request) !== null)
    return undefined

  const inferred = visitorCountry(request)
  return inferred && /^[a-z]{2}$/i.test(inferred) ? inferred.toUpperCase() : undefined
}

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
    //
    // The binding is a separate argument, not `[match]`. whereRaw takes its
    // bindings variadically, and an array is accepted silently but bound as
    // one nested value. That happens to work while it is the only binding, so
    // any other filter, including the country inferred from a browser's
    // Accept-Language or the edge's geo header, made every text search throw
    // "expected 2 values, received 1" and answer 500. Browsers send that
    // header, curl does not, which is how it hid. The builder's own docs show
    // the array form: stacksjs/bun-query-builder#1146.
    query = match
      ? query.whereRaw('id IN (SELECT rowid FROM trails_fts WHERE trails_fts MATCH ?)', match as any)
      : query.whereRaw('1 = 0')
  }

  const country = resolveCountry(request, skipInferredCountry)

  if (country)
    query = query.where('country', country)

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

  // Ascent, in feet. The catalog stores the display unit (see
  // `normalizeTrailRow`), so the bound needs no conversion on the way in.
  const minElevation = readNumber(request, 'minElevation')
  if (minElevation !== null)
    query = query.where('elevation', '>=', minElevation)

  const maxElevation = readNumber(request, 'maxElevation')
  if (maxElevation !== null)
    query = query.where('elevation', '<=', maxElevation)

  // A rating floor, not a sort. An unrated trail has `rating` 0, so it falls
  // out of any floor above zero — which is what "4.0+" is asking for.
  const minRating = readNumber(request, 'minRating')
  if (minRating !== null && minRating > 0)
    query = query.where('rating', '>=', Math.min(minRating, 5))

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
 * The band a trail's length puts it in, lowest first.
 *
 * The catalog is imported from OpenStreetMap, where a "way" is whatever a
 * mapper drew between two junctions — so most rows are not trails anybody
 * would set out to walk. A representative slice of production is 57% under
 * four tenths of a mile and has a median length of 0.32 miles.
 *
 * That is why the list used to open on the longest routes: it was the only
 * ordering that kept quarter-mile path stubs off the first screen. It bought
 * that at the cost of opening on thousand-mile thru-hikes instead, which is
 * the opposite extreme of the same mistake.
 *
 * Banding asks the question directly. A day hike comes first, then things
 * that are plausibly a walk or an expedition, then fragments and epics
 * together at the back.
 *
 * A generated column, defined in migration 0000000175, rather than a CASE in
 * the ORDER BY: ordering half a million rows by an expression cannot use an
 * index, and the ORM query builder offers no raw ordering anyway. Nothing
 * writes it — it is a function of distance, so imports get it for free.
 */
const LENGTH_BAND = 'browse_band'

/**
 * How the catalog is ordered.
 *
 * Returned as a list because the default is a composite: no single column
 * says "worth opening" while ratings, reviews, photos and elevation are all
 * empty in production, so the ordering leans on the signals that do exist
 * and keeps the ones that do not in place, ready, costing nothing.
 *
 * `rating` and `review_count` sit high deliberately. They order nothing today
 * — every row is zero — and the day the catalog gains that data they take over
 * without another change here.
 */
/**
 * Apply the ordering to a query.
 *
 * Every column named below is a literal in this file — the sort is matched
 * against `SORTS` before it reaches here, so nothing from the request is ever
 * passed to `orderBy`.
 */
// eslint-disable-next-line pickier/no-unused-vars -- names in a type signature, not bindings
function applyOrder<Q extends { orderBy: (column: string, direction: 'asc' | 'desc') => Q }>(
  query: Q,
  request: { get: (key: string) => any },
): Q {
  let ordered = query
  for (const [column, direction] of sortColumns(request))
    ordered = ordered.orderBy(column, direction)
  return ordered
}

function sortColumns(request: { get: (key: string) => any }): [string, 'asc' | 'desc'][] {
  const sort = readString(request, 'sort')

  switch (sort && SORTS.has(sort) ? sort : 'featured') {
    case 'distance':
      return [['distance', 'asc']]
    case 'longest':
      return [['distance', 'desc']]
    case 'rating':
      // An explicit "top rated" still ranks on length once the ratings run
      // out, rather than handing back whatever order the table happens to be
      // in — which is what it does today, at 0% rated.
      return [['rating', 'desc'], ['review_count', 'desc'], [LENGTH_BAND, 'asc'], ['distance', 'desc']]
    case 'name':
      return [['name', 'asc']]
    default:
      return [
        [LENGTH_BAND, 'asc'],
        ['rating', 'desc'],
        ['review_count', 'desc'],
        ['national_trail', 'desc'],
        // Within a day-hike length, the longer walk is the bigger day out.
        // Below the band this would surface epics, which is why it comes
        // after the banding rather than instead of it.
        ['distance', 'desc'],
        // Stable: two pages of the same list must not disagree about which
        // trail is 60th, or paging repeats and skips rows.
        ['id', 'asc'],
      ]
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
  // NFC, with combining marks kept inside a word, so decomposed "Zürich" is
  // one token rather than "zu" and "rich". See suggestMatch.
  const tokens = input
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
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

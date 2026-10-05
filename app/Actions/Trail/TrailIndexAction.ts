// Auth is imported explicitly: it is not in the API server bundle's
// auto-imports (see EventIndexAction).
import { Auth } from '@stacksjs/auth'
import { readPageParams } from '../../../resources/functions/pagination'
import { visitorCountry } from '../../Helpers/visitorCountry'
import { FEATURED_ORDER, NAME_ORDER, POPULAR_ORDER, RATING_ORDER } from '../../Support/catalogOrder'
import { listGeometry } from '../../Support/listGeometry'
import { withBestTrailCovers } from '../../Support/trailCovers'
import { trailEngagement } from '../../Support/trailEngagement'
import { NOT_FOLDED_SQL } from '../../Support/trailFragments'
import { trailStreetShares } from '../../Support/trailStreetShares'
import { athleteTaste } from '../../Support/trailTaste'
import { milesBetween, RANK_COLUMNS, rankTrails } from '../../Support/trailRanking'
import { WHOLE_AT_LEAST_SQL, WHOLE_AT_MOST_SQL, WHOLE_DIFFICULTY_SQL, wholeTrails, withWholeTrail } from '../../Support/wholeTrail'
import type { RankMode } from '../../Support/trailRanking'
import { difficultyIsEstimated } from '../../../resources/functions/trail-difficulty'
import { withEdgeCache } from '../../Support/edgeCache'

const DIFFICULTIES = new Set(['easy', 'moderate', 'hard'])
const ROUTE_TYPES = new Set(['loop', 'out-and-back', 'point-to-point', 'network'])
const SOURCES = new Set(['osm', 'usfs', 'nps', 'manual'])
const SORTS = new Set(['featured', 'recommended', 'popular', 'nearest', 'distance', 'longest', 'rating', 'name'])

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

/** A radius that is no box at all: a typed search with nothing nearby looks everywhere. */
const ANYWHERE = Number.POSITIVE_INFINITY

/**
 * The most rows a ranked "near me" list scores.
 *
 * The densest 25-mile circle in the catalog (Munich) holds about 3,700 trails
 * and Los Angeles about 2,200, so this is headroom rather than a limit anybody
 * meets at the default radius. A hand-widened radius can exceed it; the rows
 * kept are then the day hikes and the rated ones, which is where every
 * ranked list's first pages come from anyway.
 */
const RANK_CANDIDATE_CAP = 6000

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
      const rankMode = origin ? rankModeFor(request) : null

      const fetchPage = async (skipInferredCountry: boolean, radius?: number): Promise<{ rows: any[], total: number, personalized?: boolean }> => {
        if (origin && rankMode)
          return fetchRankedPage(request, origin, radius ?? requestedRadius(request), rankMode, page)

        const byLength = lengthOrder(request)
        const rows = byLength
          ? await fetchLengthOrderedPage(request, skipInferredCountry, radius, byLength, page)
          : await applyOrder(applyFilters(Trail.query(), request, skipInferredCountry, radius), request)
            .limit(page.limit)
            .offset(page.offset)
            .get()
        const total = await countListed(request, skipInferredCountry, radius)
        return { rows, total }
      }

      let { rows, total, personalized } = await fetchPage(false)
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
          personalized = attempt.personalized
          if (total >= MIN_NEARBY_RESULTS)
            break
        }

        /*
         * A typed search does not end at the edge of the box.
         *
         * Browsing near somebody is about what is near them, so 300 miles is
         * a fine place to stop. A search names a trail, and the trail is
         * wherever it is: from Los Angeles, "Angels Landing" (370 miles) came
         * back as nothing at all while the catalog has it. With nothing inside
         * the widest box, a search looks everywhere — still nearest first —
         * and says no radius, because none applied.
         */
        if (total === 0 && readSearch(request)) {
          const anywhere = await fetchPage(false, ANYWHERE)
          rows = anywhere.rows
          total = anywhere.total
          personalized = anywhere.personalized
          radius = null
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

      // A trail folded from pieces shows the whole trail: its length and
      // ascent with the pieces', and its own beside them (#1002,
      // app/Support/wholeTrail.ts). Its line stays its own.
      const wholes = await wholeTrails((rows ?? []).map((row: any) => Number(row.id)))
      const shown = (await withBestTrailCovers(rows ?? [])).map((row: Record<string, unknown>) => withWholeTrail(row, wholes.get(Number(row.id))))
      const trails = shown.map((row: Record<string, unknown>) => ({
        ...row,
        // Thinned to within three metres of the stored line: half the bytes,
        // and close enough for everything the client does with it, offline
        // downloads and navigation included (app/Support/listGeometry.ts).
        geometry: listGeometry(row.geometry),
        // The map layer reads `lat`/`lng`; the column names are the long form.
        lat: row.latitude,
        lng: row.longitude,
        // How far the trail starts from where the list was asked about. Only
        // on a "near me" answer, where it is what the visitor compares.
        ...(origin && Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude))
          ? { milesAway: Math.round(milesBetween(origin, Number(row.latitude), Number(row.longitude)) * 10) / 10 }
          : {}),
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

      /*
       * Shareable at the edge only when the URL alone decided the answer.
       *
       * Without a location or an explicit `?country=`, the rows were filtered
       * to a country guessed from `CF-IPCountry` or `Accept-Language` — a
       * header the edge's cache key does not include, so a copy kept for a
       * visitor in Munich would be served to one in Denver. A personalized
       * "you may like" is only ever computed for a signed-in request, which
       * `withEdgeCache` keeps private anyway; it is named here so that stays
       * true if that ever changes.
       */
      const answeredFromUrlAlone = (origin !== null || readString(request, 'country') !== null) && personalized !== true

      return withEdgeCache(request, response.json({
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
          // Present only for "you may like": whether the list was steered by
          // what this athlete saved and did, or is best match because there
          // is nothing to steer by yet. The page names the shelf from it.
          ...(personalized !== undefined ? { personalized } : {}),
        },
      }), 'list', answeredFromUrlAlone)
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
 * How a "near me" list is ranked, or null for an order SQL can answer alone.
 *
 * Best match, popular, top rated and closest all depend on where the visitor
 * is, which no column knows, so they are ranked in `trailRanking.ts`.
 * Longest, shortest and A–Z mean the same thing anywhere and stay in SQL.
 */
function rankModeFor(request: { get: (key: string) => any }): RankMode | null {
  const sort = readString(request, 'sort')
  switch (sort && SORTS.has(sort) ? sort : 'featured') {
    case 'featured':
      return 'best'
    case 'popular':
      return 'popular'
    case 'rating':
      return 'rating'
    case 'nearest':
      return 'nearest'
    case 'recommended':
      return 'recommended'
    default:
      return null
  }
}

/**
 * One page of a ranked "near me" list.
 *
 * Every candidate in the box is scored — a few thousand narrow rows — and only
 * the page is then fetched in full, so the geometry of 2,000 trails is never
 * read to show 60 of them. The total is the ranked list's length, which is
 * smaller than the box's row count: pieces of one trail are folded together.
 */
async function fetchRankedPage(
  request: { get: (key: string) => any },
  origin: Origin,
  radius: number,
  mode: RankMode,
  page: { limit: number, offset: number },
): Promise<{ rows: any[], total: number, personalized?: boolean }> {
  // "You may like" is for the signed-in athlete's next trail: steered by the
  // kind they already like, and without the ones they already know. Anybody
  // else, or anybody with nothing saved or done yet, gets best match.
  const taste = mode === 'recommended'
    ? await athleteTaste((await Auth.user().catch(() => null))?.id)
    : null

  const found = await applyFilters(Trail.query(), request, false, radius)
    .select(...RANK_COLUMNS)
    // Only decides anything when the box holds more than the cap: then the
    // rows scored are the day hikes and the rated ones.
    .orderBy('browse_band', 'asc')
    .orderBy('rating', 'desc')
    .orderBy('id', 'asc')
    .limit(RANK_CANDIDATE_CAP)
    .get() as any[]
  const unknown = taste?.known.size ? found.filter(row => !taste.known.has(Number(row.id))) : found

  // How much of each route is sidewalk, read beside the rows like
  // engagement: it is kept off the trails table (migration 0000000198).
  const candidateIds = unknown.map(row => Number(row.id))
  const [engagement, streets, wholes] = await Promise.all([trailEngagement(candidateIds), trailStreetShares(candidateIds), wholeTrails(candidateIds)])
  // Ranked on the whole trail it shows: a trail folded from pieces is as
  // long, and as hard, as its pieces together, not as its own row
  // (app/Support/wholeTrail.ts).
  const candidates = unknown.map(row => ({
    ...row,
    distance: wholes.get(Number(row.id))?.distance ?? row.distance,
    difficulty: wholes.get(Number(row.id))?.difficulty ?? row.difficulty,
    street_share: streets.get(Number(row.id)) ?? null,
  }))

  const ranked = rankTrails(candidates, origin, radius, mode, engagement, taste?.profile ?? null, readSearch(request))

  const ids = ranked.slice(page.offset, page.offset + page.limit).map(entry => Number(entry.trail.id))
  const full = ids.length > 0 ? ((await Trail.whereIn('id', ids).get()) ?? []) as any[] : []
  const byId = new Map(full.map(row => [Number(row.id), row]))
  const rows = ids.map(id => byId.get(id)).filter(Boolean)

  // At the cap the ranked length is a floor, not a count; the box's own
  // count is the honest upper figure.
  const total = found.length >= RANK_CANDIDATE_CAP
    ? await applyFilters(Trail.query(), request, false, radius).count()
    : ranked.length

  return { rows, total, ...(mode === 'recommended' ? { personalized: Boolean(taste?.profile) } : {}) }
}

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
 * Request parameters that never narrow which trails match: paging, the order,
 * and the country itself.
 */
const UNNARROWING_PARAMS = new Set(['country', 'sort', 'limit', 'offset', 'page', 'perPage', 'per_page'])

/**
 * Whether a request asks for the catalog by country and nothing else.
 *
 * Read from the query string rather than from the filters below, and as an
 * allow-list: any parameter not known to leave the matches alone — including
 * one a later filter adds — takes the general count, which is always right.
 */
function filtersByCountryOnly(request: { get: (key: string) => any, url?: string }): boolean {
  if (!request.url)
    return false
  try {
    for (const [key, value] of new URL(String(request.url), 'http://localhost').searchParams) {
      if (value.trim() !== '' && !UNNARROWING_PARAMS.has(key))
        return false
    }
    return true
  }
  catch {
    return false
  }
}

/**
 * How many trails a list holds, for its "N trails" and its paging.
 *
 * The catalog opens on the whole of one country, or of everywhere, and that
 * count is covered by a country index. Leaving pieces out with `NOT_FOLDED_SQL`
 * costs a lookup per row counted, and here every row is counted: on a
 * 600,000-row copy, 6 ms became 89 ms for one country and 7 ms became 242 ms
 * for everywhere. So that one shape is answered as the covered count less
 * the pieces in it — `trail_parts` keeps each piece's country for this — in
 * 10 ms and 5 ms, and every other filter takes the general count, whose
 * lookups are a small part of what it already reads.
 */
async function countListed(
  request: { get: (key: string) => any, url?: string },
  skipInferredCountry: boolean,
  radiusOverride?: number,
): Promise<number> {
  if (radiusOverride !== undefined || !filtersByCountryOnly(request))
    return Number(await applyFilters(Trail.query(), request, skipInferredCountry, radiusOverride).count())

  const country = resolveCountry(request, skipInferredCountry)
  const [rows, pieces] = await Promise.all([
    country ? Trail.query().where('country', country).count() : Trail.query().count(),
    (country
      ? db.sql`SELECT COUNT(*) AS n FROM trail_parts WHERE country = ${country}`
      : db.sql`SELECT COUNT(*) AS n FROM trail_parts`).execute() as Promise<Array<{ n: number }>>,
  ])
  return Math.max(0, Number(rows) - Number(pieces?.[0]?.n ?? 0))
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
  // A row that is a piece of another trail is not a trail of its own: the
  // catalog, the map and the counts list the trail it is part of instead
  // (#1002, app/Support/trailFragments.ts). A primary-key lookup per row read,
  // which leaves every plan below on the index it chose before.
  query = query.whereRaw(NOT_FOLDED_SQL)

  const search = readSearch(request)
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

  // On the whole trail's grade, as the list shows it (`trail_totals`,
  // app/Support/wholeTrail.ts).
  const difficulty = readString(request, 'difficulty')
  if (difficulty && DIFFICULTIES.has(difficulty))
    query = query.whereRaw(WHOLE_DIFFICULTY_SQL, difficulty, difficulty, difficulty)

  const routeType = readString(request, 'routeType') ?? readString(request, 'route_type')
  if (routeType && ROUTE_TYPES.has(routeType))
    query = query.where('route_type', routeType)

  const source = readString(request, 'source')
  if (source && SOURCES.has(source))
    query = query.where('source', source)

  // On the whole trail, as the list shows it (`trail_totals`,
  // app/Support/wholeTrail.ts), through the length indexes and the small
  // totals table rather than a whole length per row.
  const minDistance = readNumber(request, 'minDistance')
  if (minDistance !== null)
    query = query.whereRaw(WHOLE_AT_LEAST_SQL.distance, minDistance, minDistance)

  const maxDistance = readNumber(request, 'maxDistance')
  if (maxDistance !== null)
    query = query.whereRaw(WHOLE_AT_MOST_SQL.distance, maxDistance, maxDistance)

  // Ascent, in feet. The catalog stores the display unit (see
  // `normalizeTrailRow`), so the bound needs no conversion on the way in.
  // On the whole trail too, the same way.
  const minElevation = readNumber(request, 'minElevation')
  if (minElevation !== null)
    query = query.whereRaw(WHOLE_AT_LEAST_SQL.elevation, minElevation, minElevation)

  const maxElevation = readNumber(request, 'maxElevation')
  if (maxElevation !== null)
    query = query.whereRaw(WHOLE_AT_MOST_SQL.elevation, maxElevation, maxElevation)

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
  const box = originBox(request, radiusOverride)
  if (box) {
    query = query
      .where('latitude', '>=', box.minLat)
      .where('latitude', '<=', box.maxLat)
      .where('longitude', '>=', box.minLng)
      .where('longitude', '<=', box.maxLng)
  }

  return query
}

interface Box {
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

/** The box a "near me" list is answered in, or null when it is not one. */
function originBox(request: { get: (key: string) => any }, radiusOverride?: number): Box | null {
  const origin = readOrigin(request)
  const radius = radiusOverride ?? requestedRadius(request)
  if (!origin || !Number.isFinite(radius))
    return null

  const { lat, lng } = origin
  const latSpan = radius * DEGREES_PER_MILE
  // A degree of longitude shrinks toward the poles; without the cosine the
  // box would be far too wide in Alaska and slightly too narrow in Florida.
  const lngSpan = latSpan / Math.max(0.15, Math.cos((lat * Math.PI) / 180))
  return { minLat: lat - latSpan, maxLat: lat + latSpan, minLng: lng - lngSpan, maxLng: lng + lngSpan }
}

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
 * Every column named below is a literal, here or in `FEATURED_ORDER` — the
 * sort is matched against `SORTS` before it reaches here, so nothing from the
 * request is ever passed to `orderBy`.
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
    // Each walked in order through an index of its own, everywhere or led by
    // country, and stopped at the end of the page, as the default is
    // (migration 0000000202, app/Support/catalogOrder.ts).
    case 'rating':
      return RATING_ORDER.map(([column, direction]) => [column, direction])
    case 'popular':
      return POPULAR_ORDER.map(([column, direction]) => [column, direction])
    case 'name':
      return NAME_ORDER.map(([column, direction]) => [column, direction])
    default:
      // Walked in order through trails_browse_order_index, or the one led by
      // country, and stopped at the end of the page (migration 0000000199).
      return FEATURED_ORDER.map(([column, direction]) => [column, direction])
  }
}

/** Whether a list is ordered by length alone, and which way. */
function lengthOrder(request: { get: (key: string) => any }): 'asc' | 'desc' | null {
  const sort = readString(request, 'sort')
  return sort === 'distance' ? 'asc' : sort === 'longest' ? 'desc' : null
}

/** How many trails with a whole length are read at a time, at most. */
const MAX_WHOLE_CHUNK = 5000

/**
 * One page of a list ordered by length, on the whole trail.
 *
 * A trail folded from pieces is as long as its pieces together, which no
 * column of `trails` says, so no index of it orders by that. Two lists that
 * are each in order are merged instead. Trails with no pieces come through
 * the length indexes as before. Trails with pieces come from `trail_totals`
 * in order of its own length index, narrowed there by country, the box
 * around somebody and the search, which it carries for this, and read a
 * chunk at a time until enough of them pass every other filter. Each list
 * needs at most the page and what comes before it.
 */
async function fetchLengthOrderedPage(
  request: { get: (key: string) => any },
  skipInferredCountry: boolean,
  radiusOverride: number | undefined,
  direction: 'asc' | 'desc',
  page: { limit: number, offset: number },
): Promise<any[]> {
  const want = page.offset + page.limit

  const own = await applyFilters(Trail.query(), request, skipInferredCountry, radiusOverride)
    .whereRaw('id NOT IN (SELECT trail_id FROM trail_totals)')
    .select('id', 'distance')
    .orderBy('distance', direction)
    .limit(want)
    .get() as Array<{ id: number, distance: number }>

  const search = readSearch(request)
  const narrowing: WholeNarrowing = {
    country: resolveCountry(request, skipInferredCountry),
    box: originBox(request, radiusOverride),
    match: search ? toFtsQuery(search) : null,
  }
  const whole: Array<{ id: number, distance: number }> = []
  // Twice the page to start with, which the filters this table cannot apply
  // seldom thin by half, then twice as many each time they do. A search that
  // sanitises to nothing matches nothing, as in applyFilters.
  let size = Math.min(MAX_WHOLE_CHUNK, Math.max(100, 2 * want))
  for (let offset = 0; whole.length < want && !(search && !narrowing.match); offset += size, size = Math.min(MAX_WHOLE_CHUNK, 2 * size)) {
    const chunk = await wholeLengthsInOrder(narrowing, direction, size, offset)
    if (chunk.length === 0)
      break
    const passing = await applyFilters(Trail.query(), request, skipInferredCountry, radiusOverride)
      .whereRaw('id IN (SELECT value FROM json_each(?))', JSON.stringify(chunk.map(row => row.id)))
      .select('id')
      .get() as Array<{ id: number }>
    const kept = new Set(passing.map(row => Number(row.id)))
    whole.push(...chunk.filter(row => kept.has(row.id)))
    if (chunk.length < size)
      break
  }

  const sign = direction === 'asc' ? 1 : -1
  const ids = [
    ...own.map(row => ({ id: Number(row.id), distance: Number(row.distance) })),
    ...whole,
  ]
    // Stable: equal lengths keep the order each list gave them.
    .sort((a, b) => sign * (a.distance - b.distance))
    .slice(page.offset, want)
    .map(row => row.id)

  if (ids.length === 0)
    return []
  const full = ((await Trail.whereIn('id', ids).get()) ?? []) as any[]
  const byId = new Map(full.map(row => [Number(row.id), row]))
  return ids.map(id => byId.get(id)).filter(Boolean)
}

/** What `trail_totals` can narrow by on its own. */
interface WholeNarrowing {
  country?: string
  box: Box | null
  /** An FTS5 query, already sanitised by `toFtsQuery`. */
  match: string | null
}

/**
 * The trails with pieces in order of their whole length, a chunk at a time.
 *
 * The country and the box are written into the statement rather than bound:
 * the country is two letters `resolveCountry` checked, and the box four
 * finite numbers worked out here, so neither can carry anything else. The
 * direction is a keyword, which cannot be bound at all. The search is bound.
 */
async function wholeLengthsInOrder(
  narrowing: WholeNarrowing,
  direction: 'asc' | 'desc',
  limit: number,
  offset: number,
): Promise<Array<{ id: number, distance: number }>> {
  const where: string[] = []
  if (narrowing.country && /^[A-Z]{2}$/.test(narrowing.country))
    where.push(`country = '${narrowing.country}'`)
  const box = narrowing.box
  if (box && [box.minLat, box.maxLat, box.minLng, box.maxLng].every(Number.isFinite))
    where.push(`latitude >= ${box.minLat} AND latitude <= ${box.maxLat} AND longitude >= ${box.minLng} AND longitude <= ${box.maxLng}`)
  const filter = db.unsafe(where.length > 0 ? where.join(' AND ') : '1 = 1')
  const order = db.unsafe(direction === 'asc' ? 'ASC' : 'DESC')

  const rows = await (narrowing.match
    ? db.sql`
        SELECT trail_id, distance FROM trail_totals
        WHERE ${filter} AND trail_id IN (SELECT rowid FROM trails_fts WHERE trails_fts MATCH ${narrowing.match})
        ORDER BY distance ${order} LIMIT ${limit} OFFSET ${offset}
      `
    : db.sql`
        SELECT trail_id, distance FROM trail_totals
        WHERE ${filter}
        ORDER BY distance ${order} LIMIT ${limit} OFFSET ${offset}
      `
  ).execute().catch(() => []) as Array<{ trail_id: number, distance: number }>
  return (rows ?? []).map(row => ({ id: Number(row.trail_id), distance: Number(row.distance) }))
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

/** What was typed into search, under either of the names it arrives by. */
function readSearch(request: { get: (key: string) => any }): string | null {
  return readString(request, 'q') ?? readString(request, 'search')
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

/**
 * Autocomplete for the home search, the parts that need no database.
 *
 * Suggestions come only from WildLoop's own records: trail names, and the
 * places those trails are recorded at. Nothing is suggested that would open
 * onto an empty page.
 *
 * The SQL lives here as plain strings so the unit tests run exactly what the
 * action runs, against a real SQLite with the real migration applied.
 */

export type SuggestionKind = 'region' | 'place' | 'trail'

export interface Suggestion {
  kind: SuggestionKind
  label: string
  detail: string
  href: string
}

export interface PlaceRow {
  kind: string
  label: string
  state: string | null
  country: string | null
  trail_count: number
}

export interface TrailRow {
  id: number
  name: string
  location: string | null
}

/** Below this, a prefix matches most of the catalog and says nothing. */
export const MIN_QUERY_LENGTH = 2
export const MAX_PLACES = 4
export const MAX_TRAILS = 5

/**
 * How many name matches are ranked for the trail suggestions.
 *
 * Ranking every match is what made a broad prefix slow: at 600k trails,
 * ordering all ~150k matches for "la" took 50-90ms, blocking every other
 * request on the synchronous SQLite driver. The first few hundred matches are
 * found in single-digit milliseconds and then ordered, so a short prefix gets
 * a good sample and a specific one, having fewer matches than this, gets them
 * all.
 */
export const TRAIL_CANDIDATES = 200

/**
 * Turn typed text into an FTS5 query, or null when there is too little to
 * search.
 *
 * The input is reduced to letter and digit tokens, each quoted as a literal,
 * because FTS5 reads `"`, `*`, `:`, `-` and bare AND/OR/NOT/NEAR as syntax. The
 * last token is a prefix, since this runs as somebody types.
 *
 * The output can only contain quoted letters and digits, spaces, `*`, `:` and
 * parentheses, which is what makes it safe to inline into SQL below.
 */
export function suggestMatch(input: string, column?: 'name'): string | null {
  const tokens = String(input ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(token => token.length > 0)
    .slice(0, 6)

  if (tokens.join('').length < MIN_QUERY_LENGTH)
    return null

  const phrase = tokens
    .map((token, index) => (index === tokens.length - 1 ? `"${token}"*` : `"${token}"`))
    .join(' ')

  return column ? `${column} : (${phrase})` : phrase
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, '\'\'')}'`
}

export function placeSuggestionsSql(match: string): string {
  return `SELECT kind, label, state, country, trail_count FROM search_places
    WHERE id IN (SELECT rowid FROM search_places_fts WHERE search_places_fts MATCH ${sqlString(match)})
    ORDER BY trail_count DESC, label
    LIMIT ${MAX_PLACES}`
}

export function trailSuggestionsSql(nameMatch: string): string {
  return `SELECT id, name, location FROM trails
    WHERE id IN (
      SELECT rowid FROM trails_fts WHERE trails_fts MATCH ${sqlString(nameMatch)} LIMIT ${TRAIL_CANDIDATES}
    )
    ORDER BY review_count DESC, rating DESC, name
    LIMIT ${MAX_TRAILS}`
}

/**
 * Rebuild the place list from the trails.
 *
 * A `place` is a distinct `location`, which is a park or forest for agency
 * records and a town for records that carry one. A location that is only the
 * region name (how OSM records every trail) is left to the region row instead
 * of appearing twice.
 */
export const REBUILD_SEARCH_PLACES_SQL: string[] = [
  'DELETE FROM search_places',
  `INSERT INTO search_places (kind, label, state, state_name, country, trail_count)
    SELECT 'place', trim(location), coalesce(state, ''), max(coalesce(state_name, '')), coalesce(country, ''), count(*)
    FROM trails
    WHERE trim(coalesce(location, '')) <> ''
      AND lower(trim(location)) <> lower(trim(coalesce(state_name, '')))
    GROUP BY trim(location), coalesce(state, ''), coalesce(country, '')`,
  `INSERT INTO search_places (kind, label, state, state_name, country, trail_count)
    SELECT 'region', max(trim(state_name)), state, max(trim(state_name)), coalesce(country, ''), count(*)
    FROM trails
    WHERE trim(coalesce(state_name, '')) <> '' AND trim(coalesce(state, '')) <> ''
    GROUP BY state, coalesce(country, '')`,
  'INSERT INTO search_places_fts(search_places_fts) VALUES (\'rebuild\')',
]

function trailsLabel(count: number): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? 'trail' : 'trails'}`
}

/**
 * Where each suggestion goes.
 *
 * A region opens the region filter. A place searches its own name, which
 * finds the trails recorded there. A trail opens the trail.
 */
export function buildSuggestions(places: PlaceRow[], trails: TrailRow[]): Suggestion[] {
  const out: Suggestion[] = []

  for (const place of places) {
    // encodeURIComponent, not URLSearchParams: the latter writes a space as
    // `+`, and the home search's own `%20` form is the one /trails is known to
    // read back correctly.
    if (place.kind === 'region' && place.state) {
      const country = place.country ? `&country=${encodeURIComponent(place.country)}` : ''
      out.push({ kind: 'region', label: place.label, detail: `Region · ${trailsLabel(place.trail_count)}`, href: `/trails?state=${encodeURIComponent(place.state)}${country}` })
    }
    else if (place.kind === 'place') {
      out.push({ kind: 'place', label: place.label, detail: trailsLabel(place.trail_count), href: `/trails?q=${encodeURIComponent(place.label)}` })
    }
  }

  for (const trail of trails)
    out.push({ kind: 'trail', label: trail.name, detail: trail.location ?? '', href: `/trail/${trail.id}` })

  return out
}

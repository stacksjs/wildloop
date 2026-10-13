/**
 * The athlete directory, independent of how it is drawn.
 *
 * The web page lays it out as cards with a follow button; the native screen as
 * grouped rows. What they must agree on is who is in the list, how each one's
 * record is put into words, and which verb follows somebody — a native screen
 * guessing `POST` where the API wants `PUT` is a button that looks like it
 * worked.
 */

export interface AthleteRow {
  id: number
  name: string
  avatar: string | null
  nearYou: boolean
  activityCount: number
  followerCount: number
  territoriesOwned: number
  totalAreaOwned: number
}

/** The API's rows, with the numbers coerced and a name that is never blank. */
export function athleteRowsFrom(payload: unknown): AthleteRow[] {
  const list = (payload as { athletes?: unknown[] })?.athletes
  if (!Array.isArray(list))
    return []

  return list.map((entry) => {
    const row = entry as Record<string, unknown>
    return {
      id: Number(row.id) || 0,
      name: String(row.name || 'Athlete'),
      avatar: typeof row.avatar === 'string' && row.avatar ? row.avatar : null,
      nearYou: Boolean(row.nearYou),
      activityCount: Number(row.activityCount) || 0,
      followerCount: Number(row.followerCount) || 0,
      territoriesOwned: Number(row.territoriesOwned) || 0,
      totalAreaOwned: Number(row.totalAreaOwned) || 0,
    }
  })
}

/** Square metres as the square kilometres a territory is counted in. */
export function areaKm2(squareMetres: number): string {
  return ((Number(squareMetres) || 0) / 1_000_000).toFixed(2)
}

/** "6 activities", counting one as one. */
export function athleteActivityText(row: Pick<AthleteRow, 'activityCount'>): string {
  return row.activityCount === 1 ? '1 activity' : `${row.activityCount} activities`
}

/** "4 followers", likewise. */
export function athleteFollowerText(row: Pick<AthleteRow, 'followerCount'>): string {
  return row.followerCount === 1 ? '1 follower' : `${row.followerCount} followers`
}

/**
 * "3 held · 1.66 km²", or nothing.
 *
 * Empty for somebody holding no ground, rather than "0 held · 0.00 km²" — which
 * says the same thing at four times the length and puts a zero where an
 * achievement goes. Territory is what distinguishes this from a run tracker, so
 * the row carries it whenever there is any.
 */
export function athleteTerritoryText(row: Pick<AthleteRow, 'territoriesOwned' | 'totalAreaOwned'>): string {
  if (row.territoriesOwned <= 0)
    return ''
  return `${row.territoriesOwned} held · ${areaKm2(row.totalAreaOwned)} km²`
}

/**
 * The three parts as one line, for a screen that draws them as one.
 *
 * The parts are separate because the web page puts a styled separator and a
 * flag icon between them; a native row is one `Text`. Same words either way.
 */
export function athleteStatsLine(row: AthleteRow): string {
  return [athleteActivityText(row), athleteFollowerText(row), athleteTerritoryText(row)]
    .filter(Boolean)
    .join(' · ')
}

/** The heading over a search: the count, and the query it is for. */
export function athleteMatchLine(count: number, query: string): string {
  const trimmed = query.trim()
  const matches = count === 1 ? 'One match' : `${count} matches`
  return trimmed ? `${matches} for “${trimmed}”` : matches
}

/**
 * The request that follows or unfollows somebody.
 *
 * `PUT` to follow, `DELETE` to stop: the verb carries the direction, so there
 * is no body to get wrong and no second endpoint to keep in step.
 */
export function followRequest(athleteId: number, following: boolean): { path: string, method: 'PUT' | 'DELETE' } {
  return { path: `/api/users/${athleteId}/follow`, method: following ? 'PUT' : 'DELETE' }
}

/** The directory's own search, which is also its browse list when the query is empty. */
export function athleteSearchPath(query: string): string {
  return `/api/users/search?q=${encodeURIComponent(query.trim())}`
}

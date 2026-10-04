import type { PageMeta, PageParams } from '../../resources/functions/pagination'
import { avatarOf } from './avatars'
import { sqlId } from './clubWeeklyStats'

/**
 * The athlete directory behind `GET /api/users/search`: a name search, or
 * with no query the discover list, most active first.
 *
 * The endpoint used to load every user, then every activity those users had
 * ever recorded, GPS tracks included, only to count them, and sorted and
 * paged the lot in memory. Counting, ordering and paging happen in SQLite
 * now, so a page costs one pass over the activity index and one sort of the
 * users rather than every track in the database.
 *
 * The activity count reads only the (user_id, completed_at) index. Followers
 * are counted once per request in a grouped pass over `follows`, a narrow
 * table, rather than once per athlete: nothing indexes `following_id`, and a
 * per-athlete count would read the whole table for every row.
 *
 * Ids are inlined only after `sqlId` proves them positive integers. The one
 * piece of user text, the name pattern, is a bound parameter.
 */

/** Runs one SQL string with its parameters: `db.unsafe` in the app, SQLite in tests. */
export type RunQuery = (sql: string, params?: unknown[]) => Promise<any[]>

/** Below this a query is a discover request, not a search. */
export const MIN_NAME_QUERY = 2

export interface AthleteSearch {
  /** The trimmed `?q=`; shorter than two characters means discover. */
  text: string
  /** Users hidden from the viewer by a block, either way round. */
  blocked: Iterable<number>
  /** Athletes local to the place the request asked from; null when it asked from nowhere. */
  near: Iterable<number> | null
  page: PageParams
}

export interface AthleteRow {
  id: number
  name: string | null
  avatar: string | null
  near_you: number
  activity_count: number
  follower_count: number
  territories_owned: number
  total_area_owned: number
}

export interface Athlete {
  id: number
  name: string | null
  avatar: string | null
  nearYou: boolean
  activityCount: number
  followerCount: number
  territoriesOwned: number
  totalAreaOwned: number
}

/** A list of ids fit to inline, or null when none survive. */
export function idList(ids: Iterable<number>): string | null {
  const list = [...new Set([...ids].map(sqlId).filter((id): id is number => id !== null))]
  return list.length ? list.join(', ') : null
}

/** Whether this request is a name search rather than the discover list. */
export function isNameSearch(text: string): boolean {
  return text.length >= MIN_NAME_QUERY
}

/** The WHERE clause and its parameters, shared by the page and the count. */
function athleteFilter(search: AthleteSearch): { where: string, params: unknown[] } {
  const terms: string[] = []
  const params: unknown[] = []
  if (isNameSearch(search.text)) {
    // The pattern the ORM's `where('name', 'like', ...)` bound before, so `%`
    // and `_` in a query still behave as they did.
    terms.push('u.name LIKE ?')
    params.push(`%${search.text}%`)
  }
  const blocked = idList(search.blocked)
  if (blocked)
    terms.push(`u.id NOT IN (${blocked})`)
  return { where: terms.length ? `WHERE ${terms.join(' AND ')}` : '', params }
}

/** One page of athletes, near the viewer first, then the most active. */
export function athletePageSql(search: AthleteSearch): { sql: string, params: unknown[] } {
  const { where, params } = athleteFilter(search)
  // Near-ness only orders the discover list; a name search is by name.
  const near = search.near && !isNameSearch(search.text) ? idList(search.near) : null
  const nearYou = near ? `CASE WHEN u.id IN (${near}) THEN 1 ELSE 0 END` : '0'
  const limit = Math.max(0, Math.floor(search.page.limit))
  const offset = Math.max(0, Math.floor(search.page.offset))
  const sql = `
    SELECT u.id AS id, u.name AS name, u.avatar AS avatar,
      ${nearYou} AS near_you,
      (SELECT COUNT(*) FROM activities a WHERE a.user_id = u.id) AS activity_count,
      COALESCE(f.followers, 0) AS follower_count,
      COALESCE(ts.total_territories_owned, 0) AS territories_owned,
      COALESCE(ts.total_area_owned, 0) AS total_area_owned
    FROM users u
    LEFT JOIN (SELECT following_id, COUNT(*) AS followers FROM follows GROUP BY following_id) f ON f.following_id = u.id
    LEFT JOIN territory_stats ts ON ts.user_id = u.id
    ${where}
    ORDER BY near_you DESC, activity_count DESC, follower_count DESC, u.id ASC
    LIMIT ${limit} OFFSET ${offset}
  `.trim()
  return { sql, params }
}

/** How many athletes match, for `meta.total`. */
export function athleteCountSql(search: AthleteSearch): { sql: string, params: unknown[] } {
  const { where, params } = athleteFilter(search)
  return { sql: `SELECT COUNT(*) AS total FROM users u ${where}`.trim(), params }
}

export function toAthlete(row: AthleteRow): Athlete {
  return {
    id: Number(row.id),
    name: row.name,
    avatar: avatarOf(row),
    nearYou: !!row.near_you,
    activityCount: Number(row.activity_count) || 0,
    followerCount: Number(row.follower_count) || 0,
    territoriesOwned: row.territories_owned,
    totalAreaOwned: row.total_area_owned,
  }
}

/** The page the endpoint answers with, and its `meta` as `paginate` wrote it. */
export async function searchAthletes(run: RunQuery, search: AthleteSearch): Promise<{ athletes: Athlete[], meta: PageMeta }> {
  const page = athletePageSql(search)
  const count = athleteCountSql(search)
  const [rows, counted] = await Promise.all([run(page.sql, page.params), run(count.sql, count.params)])
  const total = Number(counted?.[0]?.total) || 0
  const { offset, limit } = search.page
  return {
    athletes: ((rows ?? []) as AthleteRow[]).map(toAthlete),
    meta: { offset, limit, total, hasMore: offset + limit < total },
  }
}

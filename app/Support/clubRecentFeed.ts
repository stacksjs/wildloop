import { canonicalStampSql, sqlId, visibleToSql } from './clubWeeklyStats'

/**
 * The newest activities from a club's members, for the club page's feed
 * (#964), counting only what the viewer may see (#957).
 *
 * The page used to load every activity its members had ever recorded, GPS
 * tracks included, sort them in memory and keep ten. Reading any column of an
 * activity row past its track means reading the track too, so the newest are
 * found from the (user_id, completed_at) index alone, a page at a time, and
 * only that page's rows are read to check visibility. Usually the first page
 * holds ten the viewer may see and that is the whole cost.
 *
 * As with the week totals in `clubWeeklyStats`, that index order is time
 * order only for stamps written the way `toISOString()` writes them. Members'
 * activities stamped any other way, or not at all, are read separately —
 * through a partial index that holds only them (migration 0000000184) — and
 * merged in by `Date.parse`, the order the feed always used.
 */

export const FEED_SIZE = 10

/** Index entries per round trip; more than a feed, so one is usually enough. */
const PAGE = 40

const CANONICAL = canonicalStampSql('a.completed_at')

const FEED_COLUMNS = `a.id AS id, a.user_id AS user_id, a.trail_id AS trail_id, a.activity_type AS activity_type,
      a.distance AS distance, a.duration AS duration, a.completed_at AS completed_at, a.created_at AS created_at`

export interface FeedRow {
  id: number
  user_id: number
  trail_id: number | null
  activity_type: string | null
  distance: number | null
  duration: string | null
  completed_at: string | null
  created_at: string | null
}

/** Runs one SQL string and returns its rows: `db.sql` in the app, SQLite in tests. */
export type RunSql = (sql: string) => Promise<any[]>

/** Where a page of index entries left off. */
interface Cursor {
  completedAt: string
  id: number
}

function clubScope(clubId: number): string {
  return `FROM club_members cm
    JOIN activities a ON a.user_id = cm.user_id AND cm.club_id = ${sqlId(clubId) ?? 0}`
}

/**
 * The next page of members' canonically stamped activities, newest first.
 * Every column it touches is in the index, so no activity row is read.
 */
export function feedPageSql(clubId: number, after: Cursor | null, limit: number = PAGE): string {
  // A cursor only ever holds a canonical stamp read back from this query,
  // which has no quote in it to strip; stripped anyway.
  const keyset = after
    ? `AND (a.completed_at < '${after.completedAt.replace(/'/g, '')}'
        OR (a.completed_at = '${after.completedAt.replace(/'/g, '')}' AND a.id > ${sqlId(after.id) ?? 0}))`
    : ''
  return `
    SELECT a.id AS id, a.completed_at AS completed_at
    ${clubScope(clubId)}
    WHERE a.completed_at = ${CANONICAL}
      ${keyset}
    ORDER BY a.completed_at DESC, a.id ASC
    LIMIT ${Math.max(1, Math.floor(limit))}
  `.trim()
}

/** The rows behind a page of ids, keeping those the viewer may see. */
export function feedRowsSql(ids: number[], viewer: number | null): string {
  const list = ids.map(sqlId).filter((id): id is number => id !== null)
  return `
    SELECT ${FEED_COLUMNS}
    FROM activities a
    WHERE a.id IN (${list.length ? list.join(', ') : 'NULL'})
      AND ${visibleToSql(viewer)}
  `.trim()
}

/** Members' visible activities stamped any other way, or not at all. */
export function feedStragglersSql(clubId: number, viewer: number | null): string {
  return `
    SELECT ${FEED_COLUMNS}
    ${clubScope(clubId)}
    WHERE (a.completed_at IS NULL OR a.completed_at IS NOT ${CANONICAL})
      AND ${visibleToSql(viewer)}
  `.trim()
}

/**
 * Newest first by `Date.parse(completed_at ?? created_at)`, as the feed always
 * sorted. Equal times keep id order. A time that can't be read sorts last:
 * the old in-memory sort left those wherever the engine happened to.
 */
export function newestFirst(rows: FeedRow[]): FeedRow[] {
  const at = (row: FeedRow) => Date.parse(row.completed_at ?? row.created_at ?? '')
  return [...rows]
    .sort((a, b) => Number(a.id) - Number(b.id))
    .sort((a, b) => {
      const x = at(a)
      const y = at(b)
      if (Number.isNaN(x) || Number.isNaN(y))
        return Number(Number.isNaN(x)) - Number(Number.isNaN(y))
      return y - x
    })
}

/** The club's newest `size` activities the viewer may see. */
export async function recentClubFeed(run: RunSql, clubId: number, viewer: number | null, size: number = FEED_SIZE): Promise<FeedRow[]> {
  const picked: FeedRow[] = []
  let after: Cursor | null = null

  while (picked.length < size) {
    const page = ((await run(feedPageSql(clubId, after))) ?? []) as Array<{ id: number, completed_at: string }>
    if (page.length === 0)
      break
    const visible = new Map(((await run(feedRowsSql(page.map(entry => Number(entry.id)), viewer))) ?? [])
      .map((row: FeedRow) => [Number(row.id), row]))
    for (const entry of page) {
      const row = visible.get(Number(entry.id))
      if (row && picked.length < size)
        picked.push(row)
    }
    if (page.length < PAGE)
      break
    const last = page[page.length - 1]
    after = { completedAt: String(last.completed_at), id: Number(last.id) }
  }

  // The newest `size` overall are among the newest `size` canonical ones and
  // the stragglers, so sorting those together is the whole answer.
  const stragglers = ((await run(feedStragglersSql(clubId, viewer))) ?? []) as FeedRow[]
  return newestFirst([...picked, ...stragglers]).slice(0, size)
}

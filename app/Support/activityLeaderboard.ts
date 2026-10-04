import { avatarOf } from './avatars'
import { canonicalStampSql, sqlId } from './clubWeeklyStats'

/**
 * The activity leaderboard behind `GET /api/activities/leaderboard`: distance,
 * elevation and activity count per athlete over a week, a month or all time,
 * for the public board, the athletes near a place, or the viewer and the
 * people they follow.
 *
 * It used to load every activity in the period, GPS tracks included, and sum
 * them in memory. The sums and counts are grouped per athlete in SQLite now,
 * from an index that holds every column they need (migration 0000000188), so
 * a board costs its period's index entries and no activity rows. Ranking the
 * totals stays here: it sorts on the rounded values the board shows, which
 * SQL would round differently, and there is one total per athlete, not per run.
 *
 * As in `clubWeeklyStats`, the period is split on how `completed_at` is
 * written. A `toISOString()` stamp compares as a string in time order, so
 * those are summed in SQL. Any other shape, or none, is fetched as a row and
 * judged exactly as the endpoint always judged it. Those are told apart in
 * the index, which holds `completed_at`, so a row is read only for an
 * activity the query returns, which in practice is none.
 *
 * Who counts is unchanged. The public boards count public activities. The
 * following board counts the viewer and the people they follow: public and
 * followers-only runs, and the viewer's own private ones. Blocks hide an
 * athlete either way round.
 */

export type BoardScope = 'global' | 'following' | 'local'
export type BoardMetric = 'distance' | 'elevation' | 'activities'

export interface BoardQuery {
  scope: BoardScope
  /** Signed-in viewer; the following board is empty without one. */
  viewer: number | null
  /** The athletes local to the place asked about, for the local board. */
  locals?: number[]
  blocked: Iterable<number>
  /** The start of the period in ms, or null for all time. */
  since: number | null
}

export interface BoardTotalRow {
  user_id: number | null
  distance: number | null
  elevation: number | null
  activities: number
}

export interface BoardActivityRow {
  user_id: number | null
  distance: number | null
  elevation: number | null
  completed_at: string | null
  created_at: string | null
}

export interface BoardEntry {
  rank: number
  userId: number
  userName: string
  userAvatar: string | null
  totalDistance: number
  totalElevation: number
  trailsCompleted: number
}

export const BOARD_SIZE = 100

const CANONICAL = canonicalStampSql('a.completed_at')

/** The earliest stamp an all-time board counts: the endpoint skipped anything before 1970. */
const EPOCH = new Date(0).toISOString()

function idList(ids: Iterable<number>): string | null {
  const list = [...new Set([...ids].map(sqlId).filter((id): id is number => id !== null))]
  return list.length ? list.join(', ') : null
}

/** The start of the period as the column stores it. Throws for a time that is not one, as the endpoint did. */
function stampOf(ms: number): string {
  return new Date(ms).toISOString().replace(/'/g, '')
}

/**
 * Whose activities, and which of them, as a WHERE clause on `a`; null when
 * the board is empty whatever the data (nobody to follow, nobody local).
 */
export function boardScopeSql(query: BoardQuery): string | null {
  const terms: string[] = []
  if (query.scope === 'following') {
    const viewer = sqlId(query.viewer)
    if (viewer === null)
      return null
    // Public and followers-only runs of the viewer and whoever they follow,
    // and the viewer's own private ones.
    terms.push(`a.visibility IN ('public', 'followers', 'private')`)
    // One IN rather than `user_id = viewer OR user_id IN (...)`: an OR here
    // plans as two index reads merged by rowid, which reads every row.
    terms.push(`a.user_id IN (SELECT ${viewer} UNION ALL SELECT following_id FROM follows WHERE follower_id = ${viewer})`)
    terms.push(`(a.visibility <> 'private' OR a.user_id = ${viewer})`)
  }
  else {
    terms.push(`a.visibility = 'public'`)
    if (query.scope === 'local') {
      const locals = idList(query.locals ?? [])
      if (!locals)
        return null
      terms.push(`a.user_id IN (${locals})`)
    }
  }
  const blocked = idList(query.blocked)
  if (blocked)
    terms.push(`(a.user_id IS NULL OR a.user_id NOT IN (${blocked}))`)
  return terms.join('\n      AND ')
}

/** Per-athlete sums over the period's canonically stamped activities. */
export function boardTotalsSql(query: BoardQuery): string | null {
  const scope = boardScopeSql(query)
  if (scope === null)
    return null
  return `
    SELECT a.user_id AS user_id, SUM(a.distance) AS distance, SUM(a.elevation) AS elevation, COUNT(*) AS activities
    FROM activities a
    WHERE ${scope}
      AND a.completed_at >= '${query.since === null ? EPOCH : stampOf(query.since)}'
      AND a.completed_at = ${CANONICAL}
    GROUP BY a.user_id
  `.trim()
}

/**
 * The scope's activities stamped any other way. With a period, those the
 * endpoint's SQL filter (`completed_at >= cutoff`, as text) let through;
 * for all time, those with no stamp too, which fall back to `created_at`.
 */
export function boardStragglersSql(query: BoardQuery): string | null {
  const scope = boardScopeSql(query)
  if (scope === null)
    return null
  const window = query.since === null
    ? `(a.completed_at IS NULL OR a.completed_at IS NOT ${CANONICAL})`
    : `a.completed_at IS NOT ${CANONICAL}
      AND a.completed_at >= '${stampOf(query.since)}'`
  return `
    SELECT a.user_id AS user_id, a.distance AS distance, a.elevation AS elevation, a.completed_at AS completed_at, a.created_at AS created_at
    FROM activities a
    WHERE ${scope}
      AND ${window}
  `.trim()
}

export interface BoardTotals {
  totalDistance: number
  totalElevation: number
  activities: number
}

/** Both reads combined per athlete. Stragglers get the endpoint's own time test. */
export function tallyBoard(totals: BoardTotalRow[], stragglers: BoardActivityRow[], since: number | null): Map<number, BoardTotals> {
  const board = new Map<number, BoardTotals>()
  const add = (userId: number, distance: number, elevation: number, activities: number) => {
    const current = board.get(userId) ?? { totalDistance: 0, totalElevation: 0, activities: 0 }
    current.totalDistance += distance
    current.totalElevation += elevation
    current.activities += activities
    board.set(userId, current)
  }

  for (const row of totals ?? [])
    add(row.user_id as number, Number(row.distance) || 0, Number(row.elevation) || 0, Number(row.activities) || 0)

  const cutoff = since ?? 0
  for (const row of stragglers ?? []) {
    if (new Date(row.completed_at ?? row.created_at).getTime() >= cutoff)
      add(row.user_id as number, row.distance || 0, row.elevation || 0, 1)
  }
  return board
}

interface RankedTotals {
  userId: number
  totalDistance: number
  totalElevation: number
  trailsCompleted: number
}

/** The top of the board, ranked on the values it shows, ties to the lower user id. */
export function rankBoard(totals: Map<number, BoardTotals>, metric: BoardMetric): RankedTotals[] {
  const sortValue = (entry: RankedTotals) => metric === 'elevation'
    ? entry.totalElevation
    : metric === 'activities' ? entry.trailsCompleted : entry.totalDistance
  return [...totals.entries()]
    .map(([userId, total]) => ({
      userId,
      totalDistance: Number(total.totalDistance.toFixed(2)),
      totalElevation: Math.round(total.totalElevation),
      trailsCompleted: total.activities,
    }))
    .sort((a, b) => sortValue(b) - sortValue(a) || a.userId - b.userId)
    .slice(0, BOARD_SIZE)
}

/** Names and avatars for the athletes on the board, and nobody else. */
export function boardPeopleSql(ids: number[]): string | null {
  const list = idList(ids)
  return list ? `SELECT id, name, avatar FROM users WHERE id IN (${list})` : null
}

/** The whole board. `run` is `db.unsafe` in the app, SQLite in tests. */
export async function activityLeaderboard(run: (sql: string) => Promise<any[]>, query: BoardQuery, metric: BoardMetric): Promise<BoardEntry[]> {
  const totalsSql = boardTotalsSql(query)
  const stragglersSql = boardStragglersSql(query)
  if (totalsSql === null || stragglersSql === null)
    return []
  const [totals, stragglers] = await Promise.all([run(totalsSql), run(stragglersSql)])
  const top = rankBoard(tallyBoard(totals as BoardTotalRow[], stragglers as BoardActivityRow[], query.since), metric)

  const peopleSql = boardPeopleSql(top.map(entry => entry.userId))
  const people = peopleSql ? ((await run(peopleSql)) ?? []) as Array<{ id: number, name: string | null, avatar: unknown }> : []
  const names = new Map(people.map(user => [Number(user.id), user.name]))
  const avatars = new Map(people.map(user => [Number(user.id), avatarOf(user)]))
  return top.map((entry, index) => ({
    rank: index + 1,
    userId: entry.userId,
    userName: names.get(entry.userId) ?? 'Athlete',
    userAvatar: avatars.get(entry.userId) ?? null,
    totalDistance: entry.totalDistance,
    totalElevation: entry.totalElevation,
    trailsCompleted: entry.trailsCompleted,
  }))
}

/**
 * Member counts and this-week totals for the clubs list and a club's
 * leaderboard (#964).
 *
 * Both used to load every activity ever recorded — GPS tracks included — to
 * count a week of mileage. These queries do the join to `club_members` and
 * the seven-day window in SQLite instead, so a request costs what the week
 * holds rather than what the activity log has grown to.
 * The SQL lives here as plain strings so the tests run exactly what the
 * action runs, the same arrangement as `trailReviewers`.
 *
 * Visibility is the rule `canViewActivity` applies (#957), restated as a
 * WHERE clause: public (or unset) counts for everyone, the viewer's own
 * activities count for them, and followers-only counts for people who follow
 * the athlete. Private mileage never reaches a club's numbers for anyone
 * else, whatever the club.
 *
 * The window splits on how `completed_at` is written. Every first-party
 * writer stores `toISOString()`, and for that one fixed-width shape a string
 * comparison is a time comparison, which the (user_id, completed_at) index
 * answers directly. The column is only required to be something `Date.parse`
 * accepts, though, so a row in any other shape (an offset, no milliseconds, an
 * RFC 2822 date from a hand-written API call) is fetched as a row and judged
 * by `Date.parse` as before. That keeps the totals exact. Those rows are
 * found through a partial index that holds only them (migration 0000000184),
 * so the extra read costs what it returns, which in practice is nothing.
 */

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * A `completed_at` exactly as `toISOString()` writes it. SQLite re-renders the
 * value in that shape; only a value already in it comes back unchanged, so an
 * impossible date (Sep 31, 24:00 — both of which `Date.parse` rolls over) or
 * any other format fails the test. The straggler queries below must keep this
 * expression word for word to match `activities_odd_completed_index`.
 */
export function canonicalStampSql(column: string): string {
  return `strftime('%Y-%m-%dT%H:%M:%fZ', ${column})`
}

const CANONICAL = canonicalStampSql('a.completed_at')

/**
 * Which activities a club's week counts: all but a track the integrity checks
 * refused. A refused track is kept in its athlete's log, and the club feed
 * still shows it, but its miles are not the club's — the club leaderboard is
 * a board like any other.
 */
const COUNTS = `a.integrity_status <> 'rejected'`

export interface MembershipRow {
  club_id: number
  members: number
  is_member: number
}

/** A week's total for one club or one member, whichever the query grouped by. */
export interface WeekTotalRow {
  group_id: number
  distance: number | null
  activities: number
}

export interface WeekActivityRow {
  group_id: number
  distance: number | null
  completed_at: string | null
}

export interface ClubWeek {
  distance: number
  activities: number
}

/** The start of the trailing week, in the shape the column stores. */
export function weekCutoff(now: number = Date.now()): string {
  return new Date(now - WEEK_MS).toISOString()
}

/**
 * An id fit to inline into SQL. Only a positive integer survives, which is
 * what makes inlining it safe; anything else is null — for a viewer, the
 * anonymous one.
 */
export function sqlId(id: unknown): number | null {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? id : null
}

/** `canViewActivity` for the activity aliased `a`, without the block list. */
export function visibleToSql(viewer: number | null): string {
  const id = sqlId(viewer)
  const publicRow = `COALESCE(a.visibility, 'public') = 'public'`
  if (id === null)
    return publicRow
  return `(
    ${publicRow}
    OR a.user_id = ${id}
    OR (a.visibility = 'followers' AND a.user_id IN (SELECT following_id FROM follows WHERE follower_id = ${id}))
  )`
}

/** Members per club, and whether the viewer is one of them. */
export function clubMembershipSql(viewer: number | null): string {
  const id = sqlId(viewer)
  const isMember = id === null ? '0' : `COALESCE(MAX(CASE WHEN user_id = ${id} THEN 1 END), 0)`
  return `
    SELECT club_id, COUNT(*) AS members, ${isMember} AS is_member
    FROM club_members
    GROUP BY club_id
  `.trim()
}

/**
 * Every club's members' activities, or one club's. A club id that is not a
 * positive integer matches no club rather than every club.
 */
function memberActivitiesSql(clubId?: number): string {
  const scope = clubId === undefined ? '' : ` AND cm.club_id = ${sqlId(clubId) ?? 0}`
  return `FROM club_members cm
    JOIN activities a ON a.user_id = cm.user_id${scope}`
}

function weekTotalsSql(groupBy: string, clubId: number | undefined, viewer: number | null, since: string): string {
  // `since` comes from `weekCutoff`, never user input, and is quoted anyway.
  const cutoff = since.replace(/'/g, '')
  return `
    SELECT ${groupBy} AS group_id, SUM(a.distance) AS distance, COUNT(*) AS activities
    ${memberActivitiesSql(clubId)}
    WHERE a.completed_at >= '${cutoff}'
      AND a.completed_at = ${CANONICAL}
      AND ${COUNTS}
      AND ${visibleToSql(viewer)}
    GROUP BY ${groupBy}
  `.trim()
}

function weekStragglersSql(groupBy: string, clubId: number | undefined, viewer: number | null): string {
  return `
    SELECT ${groupBy} AS group_id, a.distance AS distance, a.completed_at AS completed_at
    ${memberActivitiesSql(clubId)}
    WHERE a.completed_at IS NOT ${CANONICAL}
      AND ${COUNTS}
      AND ${visibleToSql(viewer)}
  `.trim()
}

/** Per-club distance and count for this week's canonically stamped activities. */
export function clubWeekTotalsSql(viewer: number | null, since: string): string {
  return weekTotalsSql('cm.club_id', undefined, viewer, since)
}

/** Visible member activities, every club, whose `completed_at` is in any other shape. */
export function clubWeekStragglersSql(viewer: number | null): string {
  return weekStragglersSql('cm.club_id', undefined, viewer)
}

/** The same week for one club, per member: its leaderboard. */
export function memberWeekTotalsSql(clubId: number, viewer: number | null, since: string): string {
  return weekTotalsSql('a.user_id', clubId, viewer, since)
}

/** One club's members' visible activities stamped in any other shape, per member. */
export function memberWeekStragglersSql(clubId: number, viewer: number | null): string {
  return weekStragglersSql('a.user_id', clubId, viewer)
}

/**
 * Combine both reads into one week per club or member. The stragglers get the
 * window test the endpoints always applied: a stamp `Date.parse` can't read
 * is skipped, as is anything before the cutoff.
 */
export function tallyWeeks(totals: WeekTotalRow[], stragglers: WeekActivityRow[], since: string): Map<number, ClubWeek> {
  const weeks = new Map<number, ClubWeek>()
  const add = (groupId: number, distance: number, activities: number) => {
    const week = weeks.get(groupId) ?? { distance: 0, activities: 0 }
    week.distance += distance
    week.activities += activities
    weeks.set(groupId, week)
  }

  for (const row of totals ?? [])
    add(Number(row.group_id), Number(row.distance) || 0, Number(row.activities) || 0)

  const cutoffMs = Date.parse(since)
  for (const row of stragglers ?? []) {
    const when = row.completed_at ? Date.parse(row.completed_at) : Number.NaN
    if (!Number.isFinite(when) || when < cutoffMs)
      continue
    add(Number(row.group_id), row.distance ?? 0, 1)
  }

  return weeks
}

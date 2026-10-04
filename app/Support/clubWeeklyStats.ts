/**
 * Member counts and this-week totals for the clubs list (#964).
 *
 * The list used to load every membership and every activity ever recorded —
 * GPS tracks included — to count a week of mileage. These queries do the join
 * to `club_members` and the seven-day window in SQLite instead, so a request
 * costs what the week holds rather than what the activity log has grown to.
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
 * by `Date.parse` as before. That keeps the totals exact; in practice it
 * returns nothing.
 */

export const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/**
 * A `completed_at` exactly as `toISOString()` writes it. SQLite re-renders the
 * value in that shape; only a value already in it comes back unchanged, so an
 * impossible date (Feb 31, 24:00) or any other format fails the test.
 */
const CANONICAL = `strftime('%Y-%m-%dT%H:%M:%fZ', a.completed_at)`

export interface MembershipRow {
  club_id: number
  members: number
  is_member: number
}

export interface WeekTotalRow {
  club_id: number
  distance: number | null
  activities: number
}

export interface WeekActivityRow {
  club_id: number
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
 * The viewer as SQL. Only a positive integer survives, which is what makes
 * inlining it safe; anything else is the anonymous viewer.
 */
function viewerId(viewer: number | null): number | null {
  return typeof viewer === 'number' && Number.isSafeInteger(viewer) && viewer > 0 ? viewer : null
}

/** `canViewActivity` for the activity aliased `a`, without the block list. */
export function visibleToSql(viewer: number | null): string {
  const id = viewerId(viewer)
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
  const id = viewerId(viewer)
  const isMember = id === null ? '0' : `COALESCE(MAX(CASE WHEN user_id = ${id} THEN 1 END), 0)`
  return `
    SELECT club_id, COUNT(*) AS members, ${isMember} AS is_member
    FROM club_members
    GROUP BY club_id
  `.trim()
}

/** Per-club distance and count for this week's canonically stamped activities. */
export function clubWeekTotalsSql(viewer: number | null, since: string): string {
  // `since` comes from `weekCutoff`, never user input, and is quoted anyway.
  const cutoff = since.replace(/'/g, '')
  return `
    SELECT cm.club_id AS club_id, SUM(a.distance) AS distance, COUNT(*) AS activities
    FROM club_members cm
    JOIN activities a ON a.user_id = cm.user_id
    WHERE a.completed_at >= '${cutoff}'
      AND a.completed_at = ${CANONICAL}
      AND ${visibleToSql(viewer)}
    GROUP BY cm.club_id
  `.trim()
}

/** Visible member activities whose `completed_at` is in any other shape. */
export function clubWeekStragglersSql(viewer: number | null): string {
  return `
    SELECT cm.club_id AS club_id, a.distance AS distance, a.completed_at AS completed_at
    FROM club_members cm
    JOIN activities a ON a.user_id = cm.user_id
    WHERE a.completed_at IS NOT ${CANONICAL}
      AND ${visibleToSql(viewer)}
  `.trim()
}

/**
 * Combine both reads into one week per club. The stragglers get the window
 * test the list always applied: a stamp `Date.parse` can't read is skipped,
 * as is anything before the cutoff.
 */
export function tallyClubWeeks(totals: WeekTotalRow[], stragglers: WeekActivityRow[], since: string): Map<number, ClubWeek> {
  const weeks = new Map<number, ClubWeek>()
  const add = (clubId: number, distance: number, activities: number) => {
    const week = weeks.get(clubId) ?? { distance: 0, activities: 0 }
    week.distance += distance
    week.activities += activities
    weeks.set(clubId, week)
  }

  for (const row of totals ?? [])
    add(Number(row.club_id), Number(row.distance) || 0, Number(row.activities) || 0)

  const cutoffMs = Date.parse(since)
  for (const row of stragglers ?? []) {
    const when = row.completed_at ? Date.parse(row.completed_at) : Number.NaN
    if (!Number.isFinite(when) || when < cutoffMs)
      continue
    add(Number(row.club_id), row.distance ?? 0, 1)
  }

  return weeks
}

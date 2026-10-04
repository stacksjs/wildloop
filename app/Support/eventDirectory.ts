import type { BackyardSchedule } from '../../resources/functions/backyard'
import type { PageMeta, PageParams } from '../../resources/functions/pagination'
import { currentYard, isStillIn } from '../../resources/functions/backyard'
import { sqlId } from './clubWeeklyStats'
import { eventPointOf } from './eventBoard'
import { matchesText } from './textQuery'

/**
 * The events directory behind `GET /api/events`.
 *
 * It used to load every event and every entrant ever registered, then work
 * out in memory which events the viewer may see, which match the filters,
 * and how full each one is. Visibility and the type, status and club filters
 * are a WHERE clause now, and the entrants are counted per event in SQL —
 * only for the page of events being returned, since nothing about the order
 * depends on them. The text filter stays in JS, where it lowercases the way
 * it always did (Unicode, not SQLite's ASCII-only LIKE), over a list that
 * holds only the events the viewer may see.
 *
 * Visibility is the rule `canViewEvent` applies: public is public; a club
 * event is for its host and the club's members; a private one for its host
 * and its entrants, including any who withdrew.
 */

export const EVENT_TYPES = new Set(['backyard', 'race', 'group_run', 'time_trial'])
export const EVENT_STATUSES = new Set(['scheduled', 'live', 'finished', 'cancelled'])

const STATUS_ORDER: Record<string, number> = { live: 0, scheduled: 1, finished: 2, cancelled: 3 }

/** Runs one SQL string and returns its rows: `db.unsafe` in the app, SQLite in tests. */
export type RunSql = (sql: string) => Promise<any[]>

export interface EventFilters {
  /** Signed-in viewer, or null. */
  viewer: number | null
  /** `?type=`; ignored unless it is one of EVENT_TYPES. */
  type?: unknown
  /** `?status=`; ignored unless it is one of EVENT_STATUSES. */
  status?: unknown
  /** `?club=`, already a positive integer or null. */
  club?: number | null
  /** `?q=` as `textQuery` returns it. */
  query: string
}

/** Every column the directory shows. Not `loop_route`, which can be a whole track. */
const EVENT_COLUMNS = `e.id AS id, e.host_id AS host_id, e.club_id AS club_id, e.trail_id AS trail_id, e.name AS name,
      e.description AS description, e.location AS location, e.event_type AS event_type, e.status AS status,
      e.visibility AS visibility, e.loop_distance AS loop_distance, e.yard_minutes AS yard_minutes,
      e.start_time AS start_time, e.max_yards AS max_yards, e.winner_id AS winner_id,
      e.latitude AS latitude, e.longitude AS longitude, e.created_at AS created_at`

/** `canViewEvent` for the event aliased `e`, as a WHERE clause. */
export function eventVisibleToSql(viewer: number | null): string {
  const id = sqlId(viewer)
  if (id === null)
    return `e.visibility = 'public'`
  return `(
      e.visibility = 'public'
      OR e.host_id = ${id}
      OR (e.visibility = 'club' AND EXISTS (SELECT 1 FROM club_members m WHERE m.club_id = e.club_id AND m.user_id = ${id}))
      OR (e.visibility <> 'club' AND EXISTS (SELECT 1 FROM event_entrants x WHERE x.event_id = e.id AND x.user_id = ${id}))
    )`
}

/** The events the viewer may see that match the filters, in id order. */
export function eventListSql(filters: EventFilters): string {
  const terms = [eventVisibleToSql(filters.viewer)]
  // Only values from the fixed sets reach the SQL.
  if (typeof filters.type === 'string' && EVENT_TYPES.has(filters.type))
    terms.push(`e.event_type = '${filters.type}'`)
  if (typeof filters.status === 'string' && EVENT_STATUSES.has(filters.status))
    terms.push(`e.status = '${filters.status}'`)
  const club = sqlId(filters.club)
  if (club !== null)
    terms.push(`e.club_id = ${club}`)
  return `
    SELECT ${EVENT_COLUMNS}
    FROM events e
    WHERE ${terms.join('\n      AND ')}
    ORDER BY e.id
  `.trim()
}

function idList(ids: Iterable<unknown>): string | null {
  const list = [...new Set([...ids].map(sqlId).filter((id): id is number => id !== null))]
  return list.length ? list.join(', ') : null
}

/**
 * The field of each event, grouped as far as the directory needs: how many
 * entrants have each status and yard count, and whether the viewer is one.
 */
export function entrantTallySql(eventIds: number[], viewer: number | null): string | null {
  const list = idList(eventIds)
  if (!list)
    return null
  const id = sqlId(viewer)
  return `
    SELECT event_id, status, yards_completed, COUNT(*) AS entrants, ${id === null ? '0' : `MAX(user_id = ${id})`} AS mine
    FROM event_entrants
    WHERE event_id IN (${list})
    GROUP BY event_id, status, yards_completed
  `.trim()
}

export interface EntrantTallyRow {
  event_id: number
  status: string
  yards_completed: number | null
  entrants: number
  mine: number
}

export interface EventField {
  entrantCount: number
  stillIn: number
  leaderYards: number
  isEntered: boolean
}

/** One event's numbers, as `standings` worked them out from every entrant row. */
export function fieldOf(groups: EntrantTallyRow[], schedule: BackyardSchedule, now: number): EventField {
  const field: EventField = { entrantCount: 0, stillIn: 0, leaderYards: 0, isEntered: false }
  for (const [index, group] of groups.entries()) {
    const count = Number(group.entrants) || 0
    const yards = group.yards_completed ?? 0
    field.entrantCount += count
    // The leader is whoever has the most yards, so their yards are the most.
    field.leaderYards = index === 0 ? yards : Math.max(field.leaderYards, yards)
    if (isStillIn({ userId: 0, status: group.status as any, yardsCompleted: yards }, schedule, now))
      field.stillIn += count
    field.isEntered = field.isEntered || !!group.mine
  }
  return field
}

/** Live first, then the next to start, then the most recently finished. Stable, so equal times keep id order. */
function byStatusThenStart(a: any, b: any): number {
  const order = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
  if (order !== 0)
    return order
  const aStart = Date.parse(a.start_time)
  const bStart = Date.parse(b.start_time)
  // Upcoming: soonest first. Finished: most recent first.
  return a.status === 'finished' ? bStart - aStart : aStart - bStart
}

/** The page of the directory the endpoint answers with, and its `meta` as `paginate` wrote it. */
export async function eventDirectory(run: RunSql, filters: EventFilters, page: PageParams, now: number = Date.now()): Promise<{ events: any[], meta: PageMeta }> {
  const listed = ((await run(eventListSql(filters))) ?? [])
    .filter((event: any) => matchesText(filters.query, event.name, event.location))
    .sort(byStatusThenStart)
  const total = listed.length
  const shown = listed.slice(page.offset, page.offset + page.limit)
  const meta = { offset: page.offset, limit: page.limit, total, hasMore: page.offset + page.limit < total }
  if (shown.length === 0)
    return { events: [], meta }

  // Only events that predate their own coordinates need their trail's.
  const trailIds = shown
    .filter((event: any) => event.trail_id && (event.latitude == null || event.longitude == null))
    .map((event: any) => event.trail_id)
  const tallySql = entrantTallySql(shown.map((event: any) => event.id), filters.viewer)
  const clubList = idList(shown.map((event: any) => event.club_id))
  const trailList = idList(trailIds)
  const [tally, clubs, trails] = await Promise.all([
    tallySql ? run(tallySql) : [],
    clubList ? run(`SELECT id, name FROM clubs WHERE id IN (${clubList})`) : [],
    trailList ? run(`SELECT id, latitude, longitude FROM trails WHERE id IN (${trailList})`).catch(() => []) : [],
  ])

  const groupsByEvent = new Map<number, EntrantTallyRow[]>()
  for (const row of (tally ?? []) as EntrantTallyRow[]) {
    const list = groupsByEvent.get(Number(row.event_id)) ?? []
    list.push(row)
    groupsByEvent.set(Number(row.event_id), list)
  }
  const clubName = new Map((clubs ?? []).map((club: any) => [club.id, club.name]))
  const trailById = new Map((trails ?? []).map((trail: any) => [trail.id, trail]))

  const events = shown.map((event: any) => {
    const schedule: BackyardSchedule = {
      startTime: event.start_time,
      yardMinutes: event.yard_minutes,
      loopDistance: event.loop_distance,
      maxYards: event.max_yards,
    }
    const field = fieldOf(groupsByEvent.get(event.id) ?? [], schedule, now)
    const point = eventPointOf(event, event.trail_id ? trailById.get(event.trail_id) : null)

    return {
      id: event.id,
      name: event.name,
      description: event.description,
      location: event.location,
      lat: point?.lat ?? null,
      lng: point?.lng ?? null,
      type: event.event_type,
      status: event.status,
      visibility: event.visibility,
      hostId: event.host_id,
      clubId: event.club_id,
      clubName: event.club_id ? clubName.get(event.club_id) ?? null : null,
      trailId: event.trail_id,
      loopDistance: event.loop_distance,
      yardMinutes: event.yard_minutes,
      startTime: event.start_time,
      maxYards: event.max_yards,
      winnerId: event.winner_id,
      entrantCount: field.entrantCount,
      stillIn: field.stillIn,
      currentYard: event.status === 'live' ? currentYard(schedule, now) : 0,
      leaderYards: field.leaderYards,
      isEntered: filters.viewer !== null && field.isEntered,
      createdAt: event.created_at,
    }
  })
  return { events, meta }
}

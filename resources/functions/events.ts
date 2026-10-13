/**
 * The events directory, independent of how it is drawn.
 *
 * The web page offers a radius, a search, a create form and three sections; the
 * native screen offers the sections and a type filter. What they must agree on
 * is what kind of event each one is, when it starts, which section it belongs
 * in, and what a backyard ultra's standing reads like mid-race.
 */

export const EVENT_TYPES = ['backyard', 'race', 'group_run', 'time_trial'] as const
export type EventType = typeof EVENT_TYPES[number]

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  backyard: 'Backyard ultra',
  race: 'Race',
  group_run: 'Group run',
  time_trial: 'Time trial',
}

export interface EventRow {
  id: number
  name: string
  location: string
  type: string
  status: string
  startTime: string
  entrantCount: number
  stillIn: number
  currentYard: number
  loopDistance: number
  yardMinutes: number
  clubName: string | null
}

/** The API's rows, with the numbers coerced and a name that is never blank. */
export function eventRowsFrom(payload: unknown): EventRow[] {
  const list = (payload as { events?: unknown[] })?.events
  if (!Array.isArray(list))
    return []

  return list.map((entry) => {
    const row = entry as Record<string, unknown>
    return {
      id: Number(row.id) || 0,
      name: String(row.name || 'Untitled event'),
      location: String(row.location ?? ''),
      type: String(row.type ?? ''),
      status: String(row.status ?? ''),
      startTime: String(row.startTime ?? ''),
      entrantCount: Number(row.entrantCount) || 0,
      stillIn: Number(row.stillIn) || 0,
      currentYard: Number(row.currentYard) || 0,
      loopDistance: Number(row.loopDistance) || 0,
      yardMinutes: Number(row.yardMinutes) || 0,
      clubName: typeof row.clubName === 'string' && row.clubName ? row.clubName : null,
    }
  })
}

/** "Backyard ultra", or the raw type when it is one this build does not know. */
export function eventTypeLabel(type: string): string {
  return EVENT_TYPE_LABELS[type as EventType] ?? type
}

/**
 * "Sat, Sep 12, 11:23".
 *
 * An unreadable date says so rather than rendering "Invalid Date": an event
 * whose start nobody recorded still belongs in the list, because somebody is
 * hosting it.
 */
export function eventWhenLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()))
    return 'Date to be confirmed'

  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export interface EventSections<T> {
  live: T[]
  upcoming: T[]
  past: T[]
}

/**
 * Live first, then what is coming, then what is over.
 *
 * A cancelled event sits with the finished ones rather than the upcoming: it is
 * not going to happen, and leaving it among the plans reads as a plan.
 */
export function eventSections<T extends { status: string }>(rows: readonly T[]): EventSections<T> {
  return {
    live: rows.filter(row => row.status === 'live'),
    upcoming: rows.filter(row => row.status === 'scheduled'),
    past: rows.filter(row => row.status === 'finished' || row.status === 'cancelled'),
  }
}

/**
 * What a row says under its name.
 *
 * A backyard ultra mid-race is a standing, not a start time: the yard everybody
 * is on and how many are still in it is the whole sport. Everything else is the
 * entrant count.
 */
export function eventStandingLine(row: EventRow): string {
  if (row.status === 'live' && row.type === 'backyard')
    return `Yard ${row.currentYard} · ${row.stillIn} still in`

  if (row.status === 'live')
    return `${row.entrantCount === 1 ? '1 entrant' : `${row.entrantCount} entrants`} · under way`

  return row.entrantCount === 1 ? '1 entrant' : `${row.entrantCount} entrants`
}

/** The directory's query: a type, or everything. */
export function eventsPath(type: string | 'all', limit = 40): string {
  const parts = [`limit=${limit}`]
  if (type && type !== 'all')
    parts.push(`type=${encodeURIComponent(type)}`)
  return `/api/events?${parts.join('&')}`
}

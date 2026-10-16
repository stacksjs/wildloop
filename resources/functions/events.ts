/**
 * The events directory, independent of how it is drawn.
 *
 * The web page offers a radius, a search, a create form and three sections; the
 * native screen offers the sections and a type filter. What they must agree on
 * is what kind of event each one is, when it starts, which section it belongs
 * in, and what a backyard ultra's standing reads like mid-race.
 */

import { formatClock } from './backyard'

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

// ── One event's own board ────────────────────────────────────────────────────

/**
 * The reading half of `/event/:id`, added when it was promoted to a native
 * screen. The list screen already shares the type labels and the when line;
 * this adds the detail payload, the live board and the entry.
 */

export function eventPath(id: number): string {
  return `/api/events/${encodeURIComponent(String(id))}`
}

export function eventLivePath(id: number): string {
  return `${eventPath(id)}/live`
}

export function eventJoinPath(id: number): string {
  return `${eventPath(id)}/join`
}

/** Plural: the endpoint is `/laps`, and `/lap` is a 404 nothing would explain. */
export function eventLapPath(id: number): string {
  return `${eventPath(id)}/laps`
}

export function eventStatusPath(id: number): string {
  return `${eventPath(id)}/status`
}

/**
 * The live board out of `/api/events/{id}/live`, which answers `{ live }`.
 *
 * Null when it is absent rather than falling back to the envelope: a dropped
 * poll is normal at a trailhead, and the screen keeps the last good board
 * rather than blanking out — the same thing the web page's `fetchLiveBoard`
 * does.
 */
export function liveBoardFrom(payload: unknown): any | null {
  return (payload as any)?.live ?? null
}

/** `/api/events/{id}` answers `{ event, live, me }`. */
export function eventDetailFrom(payload: unknown): { event: any, live: any, me: any } | null {
  const envelope = payload as any
  const event = envelope?.event
  if (!event || event.id == null)
    return null
  return {
    event,
    live: envelope.live ?? null,
    me: envelope.me ?? { entered: false },
  }
}

/**
 * The corral countdown, as of when the board was read.
 *
 * `msToNextStart` is computed by the server and arrives on the board, so there
 * is nothing to correct for a device clock — which is what makes this honest
 * on a screen that cannot tick. The web page anchors a local once-a-second
 * tick to the board's `serverTime` because a corral clock has to be smooth;
 * the native runtime does not promise a timer, so this screen shows the
 * number it was given and says when it was read.
 */
export function corralCountdownText(live: any): string {
  const ms = Number(live?.msToNextStart)
  if (!Number.isFinite(ms) || ms <= 0)
    return ''
  return formatClock(ms)
}

/** Whether an event is running now, which is when its board is worth reading. */
export function eventIsLive(live: any, event: any): boolean {
  const status = String(live?.status ?? event?.status ?? '')
  return status === 'live' || status === 'in_progress'
}

export const ENTRANT_STATUS_LABELS: Record<string, string> = {
  registered: 'In',
  running: 'In',
  winner: 'Winner',
  timed_out: 'Timed out',
  dnf: 'DNS',
  withdrawn: 'Withdrew',
}

/**
 * What a standing says about one entrant.
 *
 * `stillIn` outranks the stored status: an entrant who is running is "In"
 * whatever their row last said, and only a winner outranks that — the
 * difference between watching somebody still out there and reading them as
 * finished.
 */
export function standingStatusText(standing: any): string {
  if (standing?.status === 'winner')
    return 'Winner'
  if (standing?.stillIn)
    return 'In'
  return ENTRANT_STATUS_LABELS[String(standing?.status ?? '')] ?? 'Out'
}

export function standingLine(standing: any): string {
  const rank = standing?.rank ?? ''
  const name = standing?.name ?? 'Entrant'
  const bib = standing?.bib ? ` (${standing.bib})` : ''
  return `${rank}. ${name}${bib}`
}

export function standingYardsText(standing: any): string {
  const yards = Number(standing?.yardsCompleted ?? 0)
  const miles = Number(standing?.miles ?? 0)
  return `${yards === 1 ? '1 yard' : `${yards} yards`} · ${miles.toFixed(1)} mi`
}

export function standingsFrom(live: any): any[] {
  return Array.isArray(live?.standings) ? live.standings : []
}

export function recentLapsFrom(live: any): any[] {
  return Array.isArray(live?.recentLaps) ? live.recentLaps : []
}

export function lapLine(lap: any): string {
  return `${lap?.name ?? 'Somebody'} finished yard ${lap?.yard ?? '?'}`
}

export function lapDurationText(lap: any): string {
  return formatClock(Number(lap?.durationSeconds ?? 0) * 1000)
}

/** "12 still in of 40", which is the whole state of a backyard ultra. */
export function stillInText(live: any): string {
  const stillIn = Number(live?.stillIn ?? 0)
  const entrants = Number(live?.entrantCount ?? 0)
  return `${stillIn} still in of ${entrants}`
}

export function currentYardText(live: any): string {
  const yard = Number(live?.currentYard ?? 0)
  return yard > 0 ? `Yard ${yard}` : 'Not started'
}

export function entryLabel(me: any): string {
  return me?.entered ? 'Withdraw' : 'Enter'
}

/**
 * Whether the viewer may report a lap.
 *
 * Only an entrant who is still in, and only while the event is live — the
 * endpoint refuses the rest, and a button that is refused teaches nothing.
 */
export function canReportLap(me: any, live: any, event: any): boolean {
  if (!me?.entered || !eventIsLive(live, event))
    return false
  const status = String(me.status ?? '')
  return status !== 'timed_out' && status !== 'dnf' && status !== 'withdrawn'
}

/** The lap a report is for: the yard the board says is running. */
export function nextLapBody(live: any): { yard: number } {
  return { yard: Math.max(1, Number(live?.currentYard ?? 0) || 1) }
}

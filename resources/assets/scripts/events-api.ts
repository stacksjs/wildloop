/**
 * Fetch client for the events endpoints.
 *
 * Reads are deliberately unauthenticated where the server allows it: a live
 * backyard board is opened by crew and family who have no Wildloop account,
 * and forcing a session on them would break the one thing live reporting is
 * for. Writes carry the bearer token and the CSRF echo, same as game-api.
 */

import { apiFetch, csrfToken, readyToken, token } from './auth'

export type EventType = 'backyard' | 'race' | 'group_run' | 'time_trial'
export type EventStatus = 'scheduled' | 'live' | 'finished' | 'cancelled'
export type EntrantStatus = 'registered' | 'running' | 'timed_out' | 'withdrawn' | 'dnf' | 'winner'

export interface EventSummary {
  id: number
  name: string
  description: string | null
  location: string | null
  /** Where the event is, or null when nobody said. Drives "closest first". */
  lat: number | null
  lng: number | null
  type: EventType
  status: EventStatus
  visibility: 'public' | 'club' | 'private'
  hostId: number
  clubId: number | null
  clubName: string | null
  trailId: number | null
  loopDistance: number
  yardMinutes: number
  startTime: string
  maxYards: number | null
  winnerId: number | null
  entrantCount: number
  stillIn: number
  currentYard: number
  leaderYards: number
  isEntered: boolean
}

export interface Standing {
  rank: number
  userId: number
  name: string
  bib: string | null
  status: EntrantStatus
  yardsCompleted: number
  miles: number
  stillIn: boolean
  lastLapAt: string | null
  exitNote: string | null
}

export interface LapReport {
  userId: number
  name: string
  yard: number
  finishedAt: string
  durationSeconds: number
  distance: number | null
  activityId: number | null
  source: 'recorder' | 'manual' | 'import'
}

export interface LiveBoard {
  serverTime: string
  status: EventStatus
  currentYard: number
  yardStartsAt: string
  nextYardStartsAt: string
  msToNextStart: number
  msIntoYard: number
  entrantCount: number
  stillIn: number
  leaderYards: number
  totalMiles: number
  winnerId: number | null
  standings: Standing[]
  recentLaps: LapReport[]
}

export interface EventDetail extends EventSummary {
  hostName: string
  trailName: string | null
  loopRoute: Array<[number, number]> | null
  isHost: boolean
}

function readHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  const bearer = token()
  // A session, when there is one, is what turns a public board into "and here
  // is your own entry". Its absence is not an error.
  if (bearer)
    headers.Authorization = `Bearer ${bearer}`
  return headers
}

function writeHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...readHeaders() }
  const csrf = csrfToken()
  if (csrf)
    headers['X-CSRF-Token'] = csrf
  return headers
}

// `object`, not `Record<string, unknown>`: TypeScript gives implicit index
// signatures to type ALIASES but not to interfaces, so every typed payload
// here — CreateEventInput, LapInput — was rejected at the call site despite
// being a perfectly good JSON body. `object` accepts them and still rejects
// primitives, which is the only thing JSON.stringify would mangle.
async function post<T>(path: string, body: object): Promise<T | null> {
  await readyToken()
  try {
    const res = await apiFetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: writeHeaders(),
      body: JSON.stringify(body),
    })
    return (await res.json().catch(() => null)) as T | null
  }
  catch {
    return null
  }
}

export interface EventFilters {
  type?: EventType | 'all'
  status?: EventStatus | 'all'
  club?: number
  /** Page size. The directory sorts by distance in the browser, so it asks for the lot. */
  limit?: number
}

export async function fetchEvents(filters: EventFilters = {}): Promise<EventSummary[] | null> {
  const params = new URLSearchParams()
  if (filters.type && filters.type !== 'all')
    params.set('type', filters.type)
  if (filters.status && filters.status !== 'all')
    params.set('status', filters.status)
  if (filters.club)
    params.set('club', String(filters.club))
  if (filters.limit)
    params.set('limit', String(filters.limit))

  try {
    const query = params.toString()
    const res = await apiFetch(`/api/events${query ? `?${query}` : ''}`, { headers: readHeaders() })
    const payload = await res.json().catch(() => null)
    return res.ok && Array.isArray(payload?.events) ? payload.events : null
  }
  catch {
    return null
  }
}

export async function fetchEvent(id: number): Promise<{ event: EventDetail, live: LiveBoard, me: any } | null> {
  try {
    const res = await apiFetch(`/api/events/${id}`, { headers: readHeaders() })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.event)
      return null
    return { event: payload.event, live: payload.live, me: payload.me }
  }
  catch {
    return null
  }
}

export async function fetchLiveBoard(id: number): Promise<LiveBoard | null> {
  try {
    const res = await apiFetch(`/api/events/${id}/live`, { headers: readHeaders() })
    const payload = await res.json().catch(() => null)
    return res.ok && payload?.live ? payload.live : null
  }
  catch {
    // A dropped poll is normal at a trailhead. The board keeps the last good
    // state and tries again rather than blanking out.
    return null
  }
}

export interface CreateEventInput {
  name: string
  event_type: EventType
  start_time: string
  yard_minutes: number
  loop_distance: number
  visibility?: 'public' | 'club' | 'private'
  description?: string | null
  location?: string | null
  /** Ignored when `trail_id` names a trail: the event takes the trail's point. */
  lat?: number | null
  lng?: number | null
  club_id?: number | null
  trail_id?: number | null
  max_yards?: number | null
}

export function createEvent(input: CreateEventInput) {
  return post<{ success: boolean, event?: EventSummary, error?: string, fields?: Record<string, string> }>('/api/events', input)
}

export function toggleEventEntry(id: number, note?: string) {
  return post<{ success: boolean, entered?: boolean, entrantCount?: number, error?: string }>(`/api/events/${id}/join`, { note })
}

export function setEventStatus(id: number, status: EventStatus) {
  return post<{ success: boolean, event?: { status: EventStatus, startTime: string }, error?: string }>(`/api/events/${id}/status`, { status })
}

export interface LapInput {
  yard?: number
  user_id?: number
  finished_at?: string
  started_at?: string
  duration_seconds?: number
  distance?: number
  activity_id?: number
}

export function reportLap(id: number, lap: LapInput) {
  return post<{
    success: boolean
    duplicate?: boolean
    yard?: number
    yardsCompleted?: number
    stillIn?: number
    rank?: number | null
    finished?: boolean
    winnerId?: number | null
    error?: string
  }>(`/api/events/${id}/laps`, lap)
}

/* ── Club invites ──────────────────────────────────────────────────────── */

export interface ClubInvite {
  id: number
  code: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
  invitedUserId: number | null
  invitedName: string | null
  invitedEmail: string | null
  invitedByName: string
  note: string | null
  expiresAt: string | null
  acceptedAt: string | null
  createdAt: string
}

export async function fetchClubInvites(clubId: number): Promise<ClubInvite[] | null> {
  await readyToken()
  try {
    const res = await apiFetch(`/api/clubs/${clubId}/invites`, { headers: readHeaders() })
    const payload = await res.json().catch(() => null)
    return res.ok && Array.isArray(payload?.invites) ? payload.invites : null
  }
  catch {
    return null
  }
}

export function inviteToClub(clubId: number, input: { email?: string, user_id?: number, note?: string }) {
  return post<{ success: boolean, invite?: ClubInvite, reused?: boolean, error?: string, fields?: Record<string, string> }>(
    `/api/clubs/${clubId}/invites`,
    input,
  )
}

export function redeemClubInvite(code: string) {
  return post<{ success: boolean, joined?: boolean, club?: { id: number, name: string }, error?: string }>(
    '/api/clubs/invites/accept',
    { code },
  )
}

/**
 * Fetch client for the route-records endpoints.
 *
 * Reads go out unauthenticated by design. A records board is a reference work
 * — a route page is the thing somebody links to from a forum post — and the
 * tracking board is opened by crew and family who have no WildLoop account.
 * A session, when there is one, only adds the viewer's own unpublished
 * claims. Writes carry the bearer token and the CSRF echo, same as events-api.
 */

import type {
  RecordCategory,
  RecordDirection,
  RecordStatus,
  RecordStyle,
} from '../../functions/route-records'
import type { LatLng } from './trail-data'
import { apiFetch, csrfToken, readyToken, token } from './auth'
import { parseTrailGeometry } from './trail-data'

export type { RecordCategory, RecordDirection, RecordStatus, RecordStyle }

export interface RecordEffortView {
  id: number
  userId: number
  userName: string
  trailId: number
  trailName: string
  trailDistance: number
  trailLocation: string | null
  activityId: number | null
  style: RecordStyle
  category: RecordCategory
  direction: RecordDirection
  teamSize: number
  status: RecordStatus
  startedAt: string
  finishedAt: string | null
  elapsedSeconds: number | null
  elapsedLabel: string
  paceLabel: string
  evidenceUrl: string | null
  gpxUrl: string | null
  trackerUrl: string | null
  tripReport: string | null
  reviewNote: string | null
  reviewedAt: string | null
  createdAt: string | null
}

export interface TrackedEffort extends RecordEffortView {
  /** Time on the course so far — the only clock an unfinished attempt has. */
  elapsedSoFar: number
  elapsedSoFarLabel: string
}

export interface RecordBoardView {
  key: string
  label: string
  direction: RecordDirection
  category: RecordCategory
  style: RecordStyle
  team: boolean
  entries: (RecordEffortView & { rank: number, headline: boolean })[]
}

export interface TrailRecordsView {
  trail: {
    id: number
    name: string
    location: string | null
    distance: number
    elevation: number
    routeType: string | null
  }
  rankable: boolean
  rankableReason: string | null
  outright: (RecordEffortView & { rank: number }) | null
  boards: RecordBoardView[]
  inProgress: RecordEffortView[]
  totalEfforts: number
}

export interface EffortDetailView extends RecordEffortView {
  rank: number | null
  bucketSize: number
  headline: boolean
  isOwner: boolean
  canReview: boolean
}

export interface PageMeta {
  offset: number
  limit: number
  total: number
  hasMore: boolean
}

function readHeaders(): Record<string, string> {
  const headers: Record<string, string> = {}
  const bearer = token()
  // A session, when there is one, is what turns a public board into "and here
  // is your own pending claim". Its absence is not an error.
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
// signatures to type ALIASES but not to interfaces, so a typed payload like
// FileEffortInput is rejected at the call site despite being valid JSON.
async function send<T>(method: 'POST' | 'PATCH' | 'DELETE', path: string, body?: object): Promise<T | null> {
  await readyToken()
  try {
    const res = await apiFetch(path, {
      method,
      credentials: 'same-origin',
      headers: writeHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return (await res.json().catch(() => null)) as T | null
  }
  catch {
    return null
  }
}

export interface RecordFilters {
  trailId?: number
  userId?: number
  style?: RecordStyle
  category?: RecordCategory
  direction?: RecordDirection
  /** `all` returns every status the viewer is allowed to see. */
  status?: RecordStatus | 'all'
  limit?: number
  offset?: number
}

export async function fetchRecords(filters: RecordFilters = {}): Promise<{ efforts: RecordEffortView[], meta: PageMeta } | null> {
  const params = new URLSearchParams()
  if (filters.trailId) params.set('trail_id', String(filters.trailId))
  if (filters.userId) params.set('user_id', String(filters.userId))
  if (filters.style) params.set('style', filters.style)
  if (filters.category) params.set('category', filters.category)
  if (filters.direction) params.set('direction', filters.direction)
  if (filters.status) params.set('status', filters.status)
  if (filters.limit) params.set('limit', String(filters.limit))
  if (filters.offset) params.set('offset', String(filters.offset))

  try {
    const query = params.toString()
    const res = await apiFetch(`/api/route-efforts${query ? `?${query}` : ''}`, { headers: readHeaders() })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !Array.isArray(payload?.efforts))
      return null
    return { efforts: payload.efforts, meta: payload.meta }
  }
  catch {
    return null
  }
}

export async function fetchTracking(): Promise<TrackedEffort[] | null> {
  try {
    const res = await apiFetch('/api/route-efforts/tracking', { headers: readHeaders() })
    const payload = await res.json().catch(() => null)
    return res.ok && Array.isArray(payload?.tracking) ? payload.tracking : null
  }
  catch {
    // A dropped poll is normal on a phone at a trailhead. The board keeps its
    // last good state and tries again rather than blanking out.
    return null
  }
}

export async function fetchTrailRecords(trailId: number): Promise<TrailRecordsView | null> {
  try {
    const res = await apiFetch(`/api/trails/${trailId}/records`, { headers: readHeaders() })
    const payload = await res.json().catch(() => null)
    return res.ok && payload?.success ? payload as TrailRecordsView : null
  }
  catch {
    return null
  }
}

export async function fetchEffort(id: number): Promise<EffortDetailView | null> {
  try {
    const res = await apiFetch(`/api/route-efforts/${id}`, { headers: readHeaders() })
    const payload = await res.json().catch(() => null)
    return res.ok && payload?.effort ? payload.effort : null
  }
  catch {
    return null
  }
}

/** Where an attempt is run: the route's line, and its trailhead. */
export interface CourseView {
  /** Empty when the route has no stored geometry. */
  line: LatLng[]
  trailhead: LatLng | null
}

/**
 * The course an attempt is run on, to draw on a map.
 *
 * Read from the trail rather than carried on the effort: every attempt on a
 * route shares one course, and a live attempt is watched by people who want
 * to see where it goes, not just a clock. Many catalog routes have a
 * trailhead but no stored line, so both come back and the page draws what
 * there is. Null only when there is neither.
 */
export async function fetchCourse(trailId: number): Promise<CourseView | null> {
  try {
    const res = await apiFetch(`/api/trails/${trailId}`, { headers: readHeaders() })
    const payload = await res.json().catch(() => null)
    if (!res.ok || !payload?.trail)
      return null
    const line = parseTrailGeometry(payload.trail.geometry)
    const lat = Number(payload.trail.lat ?? payload.trail.latitude)
    const lng = Number(payload.trail.lng ?? payload.trail.longitude)
    const trailhead: LatLng | null = line[0]
      ?? (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0) ? [lat, lng] : null)
    return trailhead ? { line, trailhead } : null
  }
  catch {
    return null
  }
}

export interface FileEffortInput {
  trail_id: number
  style: RecordStyle
  category: RecordCategory
  direction: RecordDirection
  started_at: string
  /** Omit to announce an attempt that is still out there. */
  finished_at?: string | null
  team_size?: number
  activity_id?: number | null
  evidence_url?: string | null
  gpx_url?: string | null
  tracker_url?: string | null
  trip_report?: string | null
}

export interface EffortMutationResult {
  success: boolean
  effort?: RecordEffortView
  error?: string
  fields?: Record<string, string>
}

export function fileEffort(input: FileEffortInput) {
  return send<EffortMutationResult>('POST', '/api/route-efforts', input)
}

export interface UpdateEffortInput {
  finished_at?: string
  /** `dnf` closes the attempt without a time — the honest end of most of them. */
  outcome?: 'dnf'
  trip_report?: string | null
  evidence_url?: string | null
  gpx_url?: string | null
  tracker_url?: string | null
}

export function updateEffort(id: number, input: UpdateEffortInput) {
  return send<EffortMutationResult>('PATCH', `/api/route-efforts/${id}`, input)
}

export function withdrawEffort(id: number) {
  return send<{ success: boolean, deleted?: number, error?: string }>('DELETE', `/api/route-efforts/${id}`)
}

export function reviewEffort(id: number, decision: 'verify' | 'reject' | 'reopen', note?: string) {
  return send<EffortMutationResult>('POST', `/api/route-efforts/${id}/review`, { decision, note })
}

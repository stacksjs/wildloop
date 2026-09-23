/**
 * Minimal fetch client for the territory game endpoints.
 *
 * Calls hit the relative `/api/*` paths, which the frontend dev server proxies
 * to the API server (see serve.ts). Routes are auto-prefixed with `/api`.
 *
 * Keys are snake_case to match the backend Actions / ORM.
 */

import { describeResponseError } from './request-error'
import { uploadNeedsAttention } from './run-upload-queue'

export interface CreatedActivity {
  id: number
  userId: number
  activityType: string
  distance: number
  hasGps: boolean
  captureEligible?: boolean
  integrityStatus?: string
  integrityReason?: string | null
}

export interface ClaimResult {
  success: boolean
  error?: string
  territory?: { id: number, name: string, areaSize: number, centerLat: number, centerLng: number }
  /** Authoritative XP from the server (#947). */
  xpGained?: number
  totalXp?: number
}

export interface ConquestResult {
  success: boolean
  error?: string
  conqueredCount?: number
  territories?: Array<{ originalId: number, conqueredArea: number, remainingArea: number, newTerritoryId?: number }>
  /** Enemy territories this run attacked without taking land (now 'contested'). */
  contested?: Array<{ id: number, name: string }>
  /** Own contested territories this run defended (back to 'active'). */
  defended?: Array<{ id: number, name: string }>
  /** Authoritative XP from the server (#947). */
  xpGained?: number
  totalXp?: number
}

import { apiFetch, initializeAuthSession, readyToken, token } from './auth'

void initializeAuthSession()

/**
 * Read the double-submit CSRF cookie the framework middleware plants on safe
 * responses. Returns null off-browser or before the first GET has landed.
 */
function csrfToken(): string | null {
  if (typeof document === 'undefined')
    return null
  for (const part of document.cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1)
      continue
    if (part.slice(0, separator).trim() !== 'X-CSRF-Token')
      continue
    const value = part.slice(separator + 1).trim()
    return value ? decodeURIComponent(value) : null
  }
  return null
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const bearer = token()
  if (bearer)
    headers.Authorization = `Bearer ${bearer}`

  // CSRF is default-on for unsafe methods. A bearer token exempts the request
  // server-side, but the very first call is the sign-in that mints that token,
  // so without the echoed cookie every session started with a 403 and the app
  // silently fell back to read-only seed data.
  const csrf = csrfToken()
  if (csrf)
    headers['X-CSRF-Token'] = csrf

  return headers
}

/**
 * Preserve the existing call sites while enforcing an important invariant:
 * the app never manufactures a session. Guests remain guests until they sign
 * in or register, and the API remains the authority for every write.
 */
export function ensureSession(): Promise<void> {
  return readyToken().then(() => undefined)
}

/** Convert recorded [lat, lng] points to a GeoJSON LineString string the engine parses. */
export function routeToGeoJson(
  points: Array<[number, number]>,
  samples: Array<{ t: number, accuracy?: number | null, eleFt?: number | null }> = [],
): string {
  return JSON.stringify({
    type: 'LineString',
    coordinates: points.map(([lat, lng]) => [lng, lat]),
    properties: {
      samples: points.map((_, index) => ({
        time: samples[index]?.t ?? null,
        accuracy: samples[index]?.accuracy ?? null,
        altitude: samples[index]?.eleFt ?? null,
      })),
    },
  })
}

export interface ActivityPayload {
  user_id: number
  trail_id?: number | null
  activity_type: string
  distance: number
  /** Wall-clock elapsed time (includes pauses). */
  duration: string
  /** Pause-aware moving time - what pace is computed from (#960). */
  moving_time?: string | null
  pace?: string | null
  elevation?: number
  gpx_data?: string | null
  /** Per-mile splits computed from the GPS samples (#952). */
  splits?: Array<{ mile: number, pace: string, elev: number }>
  notes?: string
  /** Who can see it (#957): public | followers | private. Defaults public. */
  visibility?: string
  completed_at?: string
  /** Stable client id used to deduplicate retries and offline replays. */
  upload_id?: string
  recording_source?: 'web_gps' | 'native_gps' | 'simulation' | 'manual' | 'file_import' | 'garmin'
  game_mode?: 'capture' | 'free' | 'none'
  /** Optional focus target. The server will resolve battles only for this id. */
  target_territory_id?: number | null
}

/** Persist a recorded run as an Activity. Returns the created activity (with id). */
export async function createActivity(payload: ActivityPayload): Promise<CreatedActivity | null> {
  await ensureSession()
  const res = await apiFetch('/api/activities', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const failure = describeResponseError(res.status, { ...body, errors: body?.fields ?? body?.errors })
    const message = failure.fields ? Object.values(failure.fields).join(' ') : failure.message
    const error = new Error(message) as Error & { retryable?: boolean, status?: number }
    error.retryable = res.status >= 500 || res.status === 408 || res.status === 429
    error.status = res.status
    throw error
  }
  const json = await res.json()
  return json?.activity ?? null
}

/** What the recorder tells someone whose run was kept on the device instead of uploaded. */
export function queuedRunMessage(error: unknown): string {
  const status = (error as { status?: number } | null)?.status
  if (status === 401)
    return 'Saved on this device. Sign in again and it will upload.'
  if (uploadNeedsAttention(error)) {
    const reason = error instanceof Error && error.message ? ` (${error.message})` : ''
    return `Saved on this device, but Wildloop did not accept it${reason}. Automatic retries stopped. Open Record to export a backup or retry after resolving the issue.`
  }
  return 'Saved on this device and will sync when Wildloop is online'
}

export interface ActivityUpdatePayload {
  activity_type?: string
  notes?: string | null
  visibility?: string
  trail_id?: number | null
  // Measured fields - the API only accepts these for manual (non-GPS) entries.
  distance?: number
  duration?: string
  moving_time?: string
  pace?: string
  elevation?: number
  completed_at?: string
}

/** Edit an activity (owner only). Returns { success, activity?, error? }. */
export async function updateActivity(activityId: number, payload: ActivityUpdatePayload): Promise<{ success: boolean, activity?: any, error?: string }> {
  await ensureSession()
  const res = await apiFetch(`/api/activities/${activityId}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
  try {
    return await res.json()
  }
  catch {
    return { success: false, error: `HTTP ${res.status}` }
  }
}

/** Delete an activity (owner only). Kudos/comments cascade; territory stays. */
export async function deleteActivity(activityId: number): Promise<boolean> {
  await ensureSession()
  const res = await apiFetch(`/api/activities/${activityId}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  return res.ok
}

export interface ActivityComment {
  id: number
  userId: number
  userName: string
  body: string
  createdAt: string
}

/** Fetch a single activity (incl. parsed route + comments). */
export async function fetchActivityDetail(activityId: number): Promise<any | null> {
  const res = await apiFetch(`/api/activities/${activityId}`, { headers: authHeaders() })
  if (!res.ok)
    return null
  const json = await res.json()
  return json?.activity ?? null
}

/** Post a comment on an activity; returns the created comment. */
export async function postComment(activityId: number, userId: number, body: string): Promise<ActivityComment | null> {
  await ensureSession()
  const res = await apiFetch(`/api/activities/${activityId}/comments`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ user_id: userId, body }),
  })
  if (!res.ok)
    return null
  const json = await res.json()
  return json?.comment ?? null
}

export interface KudosResult {
  success: boolean
  kudosed?: boolean
  kudosCount?: number
}

/**
 * Give (`kudosed` true) or take back kudos; returns the authoritative count.
 *
 * Save, kudos, follow and block send the state wanted, PUT to add and DELETE
 * to remove, so a double tap or a retried request cannot undo itself.
 */
export async function toggleKudos(activityId: number, userId: number, kudosed: boolean): Promise<KudosResult> {
  await ensureSession()
  const res = await apiFetch(`/api/activities/${activityId}/kudos`, {
    method: kudosed ? 'PUT' : 'DELETE',
    headers: authHeaders(),
    body: JSON.stringify({ user_id: userId }),
  })
  return res.json()
}

export interface FollowsResult {
  followerCount: number
  followingCount: number
  followerIds: number[]
  followingIds: number[]
}

/** Fetch the current user's notifications (auth). */
type NotificationPage = { notifications: any[], unreadCount: number } | null

/** How long one answer serves every caller that asks at about the same time. */
const NOTIFICATIONS_FRESH_MS = 2000

interface SharedNotifications {
  pending: Promise<NotificationPage> | null
  value: NotificationPage
  at: number
}

/**
 * Page-wide, like the session: this module is inlined into several bundles.
 * The desktop nav, the mobile header and the notification list each ask on
 * load and again when the session is restored, which was thirteen requests
 * for one page. Callers that ask together now share one.
 */
const sharedNotifications: SharedNotifications
  = (globalThis as typeof globalThis & { __wildloopNotifications?: SharedNotifications }).__wildloopNotifications
    ??= { pending: null, value: null, at: 0 }

export async function fetchNotifications(): Promise<NotificationPage> {
  if (sharedNotifications.pending)
    return sharedNotifications.pending
  if (sharedNotifications.value && Date.now() - sharedNotifications.at < NOTIFICATIONS_FRESH_MS)
    return sharedNotifications.value

  sharedNotifications.pending = (async () => {
    await ensureSession()
    const res = await apiFetch('/api/notifications', { headers: authHeaders() })
    if (!res.ok)
      return null
    const json = await res.json()
    return json?.success ? json : null
  })()
  try {
    const value = await sharedNotifications.pending
    sharedNotifications.value = value
    sharedNotifications.at = Date.now()
    return value
  }
  finally {
    sharedNotifications.pending = null
  }
}

/** Mark notifications read (all, or a single id). */
export async function markNotificationsRead(id?: number): Promise<boolean> {
  await ensureSession()
  const res = await apiFetch('/api/notifications/read', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(id ? { id } : {}),
  })
  // The next read has to see the change, not the answer from before it.
  sharedNotifications.value = null
  return res.ok
}

// --- Challenges (#965) -------------------------------------------------------

/** List the session user's challenges (sent + received). */
export async function fetchChallenges(): Promise<any[] | null> {
  const bearer = await readyToken()
  if (!bearer)
    return null
  const res = await apiFetch('/api/challenges', { headers: authHeaders() })
  if (!res.ok)
    return null
  const json = await res.json()
  return json?.success ? json.challenges : null
}

/** Create a challenge over a rival's territory (opponent + stake derived). */
export async function createChallenge(territoryId: number, deadline?: string): Promise<{ success: boolean, challenge?: any, error?: string, fields?: Record<string, string> }> {
  await ensureSession()
  const res = await apiFetch('/api/challenges', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(deadline ? { territory_id: territoryId, deadline } : { territory_id: territoryId }),
  })
  try {
    return await res.json()
  }
  catch {
    return { success: false, error: `HTTP ${res.status}` }
  }
}

/** Accept or decline a pending challenge (defender only). */
export async function respondToChallenge(challengeId: number, action: 'accept' | 'decline'): Promise<{ success: boolean, challenge?: any, error?: string }> {
  await ensureSession()
  const res = await apiFetch(`/api/challenges/${challengeId}/respond`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ action }),
  })
  try {
    return await res.json()
  }
  catch {
    return { success: false, error: `HTTP ${res.status}` }
  }
}

// --- Clubs (#964) ------------------------------------------------------------

export interface ClubPayload {
  name: string
  club_type: string
  description?: string | null
  location?: string | null
  /** Visibility: whether the club is listed to non-members at all. */
  is_private?: boolean
  /** Whether a stranger may join. A closed team needs a ClubInvite instead. */
  join_policy?: 'open' | 'request' | 'invite_only'
  website?: string | null
}

/** List clubs (public; private clubs only when the session user is a member). */
export async function fetchClubs(): Promise<any[] | null> {
  await ensureSession()
  const res = await apiFetch('/api/clubs', { headers: authHeaders() })
  if (!res.ok)
    return null
  const json = await res.json()
  return json?.success ? json.clubs : null
}

/** Club detail: members, recent feed, leaderboard. */
export async function fetchClubDetail(clubId: number): Promise<any | null> {
  await ensureSession()
  const res = await apiFetch(`/api/clubs/${clubId}`, { headers: authHeaders() })
  if (!res.ok)
    return null
  const json = await res.json()
  return json?.success ? json.club : null
}

/** Create a club; the creator becomes its owner. */
export async function createClub(payload: ClubPayload): Promise<{ success: boolean, club?: any, error?: string, fields?: Record<string, string> }> {
  await ensureSession()
  const res = await apiFetch('/api/clubs', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
  try {
    return await res.json()
  }
  catch {
    return { success: false, error: `HTTP ${res.status}` }
  }
}

/** Delete a club (owner only). */
export async function deleteClub(clubId: number): Promise<boolean> {
  await ensureSession()
  const res = await apiFetch(`/api/clubs/${clubId}`, { method: 'DELETE', headers: authHeaders() })
  return res.ok
}

/** Join or leave a club; returns the new membership state + count. */
export async function toggleClubMembership(clubId: number): Promise<{ success: boolean, joined?: boolean, memberCount?: number, error?: string }> {
  await ensureSession()
  const res = await apiFetch(`/api/clubs/${clubId}/join`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({}),
  })
  try {
    return await res.json()
  }
  catch {
    return { success: false, error: `HTTP ${res.status}` }
  }
}

export interface TrailReview {
  id: number
  userId: number
  userName: string
  rating: number
  title: string | null
  content: string
  conditions: string | null
  visitDate: string | null
  createdAt: string
}

/** Fetch a trail's reviews (author names joined, newest first) (#981). */
export async function fetchTrailReviews(trailId: number): Promise<TrailReview[] | null> {
  return (await fetchTrailReviewPage(trailId))?.reviews ?? null
}

/** How hard reviewers found a trail: votes per level, and the leader if there is one. */
export interface TrailDifficultySummary {
  easy: number
  moderate: number
  hard: number
  total: number
  consensus: 'easy' | 'moderate' | 'hard' | null
}

/** A trail's reviews together with the tally of their difficulty votes. */
export async function fetchTrailReviewPage(trailId: number): Promise<{ reviews: TrailReview[], difficulty: TrailDifficultySummary | null } | null> {
  const res = await apiFetch(`/api/trails/${trailId}/reviews`)
  if (!res.ok)
    return null
  const json = await res.json()
  return json?.success ? { reviews: json.reviews, difficulty: json.difficulty ?? null } : null
}

/**
 * Upload one photo to a trail. The server re-encodes it, which drops its GPS
 * position, and answers with the stored photo's id and URLs.
 */
export async function uploadTrailPhoto(trailId: number, file: Blob): Promise<{ success: boolean, photo?: { id: string, url: string, thumbUrl: string }, error?: string }> {
  await ensureSession()
  // Multipart: the browser writes the boundary into Content-Type, so the JSON
  // one authHeaders() sets must not go with it.
  const headers = authHeaders()
  delete headers['Content-Type']
  const body = new FormData()
  body.append('photo', file)
  const res = await apiFetch(`/api/trails/${trailId}/photos`, { method: 'POST', headers, body })
  try {
    return await res.json()
  }
  catch {
    return { success: false, error: `HTTP ${res.status}` }
  }
}

/** Create or update the session user's review of a trail (#981). */
export async function postTrailReview(trailId: number, payload: { rating: number, content: string, conditions?: string | null, title?: string | null, difficulty?: string | null, photo_ids?: string[] }): Promise<{ success: boolean, review?: any, trail?: { id: number, rating: number, reviewCount: number }, updated?: boolean, error?: string, fields?: Record<string, string> }> {
  await ensureSession()
  const res = await apiFetch(`/api/trails/${trailId}/reviews`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
  try {
    return await res.json()
  }
  catch {
    return { success: false, error: `HTTP ${res.status}` }
  }
}

/** Save or unsave a trail for the session user (#969). */
export async function toggleSaveTrail(trailId: number, saved: boolean): Promise<{ success: boolean, saved?: boolean }> {
  await ensureSession()
  const res = await apiFetch(`/api/trails/${trailId}/save`, {
    method: saved ? 'PUT' : 'DELETE',
    headers: authHeaders(),
    body: JSON.stringify({}),
  })
  if (!res.ok)
    return { success: false }
  return res.json()
}

/** Fetch a user's saved trails (with trail summaries) (#969). */
export async function fetchSavedTrails(userId: number): Promise<{ savedTrails: any[] } | null> {
  // The shared catalog renders for guests with a sentinel user id of zero.
  // Saved trails are meaningful only for a real account; do not turn that
  // sentinel into `/api/users/0/saved-trails` and a guaranteed validation
  // error on every public trail page.
  if (!Number.isInteger(userId) || userId <= 0)
    return null
  const res = await apiFetch(`/api/users/${userId}/saved-trails`, { headers: authHeaders() })
  if (!res.ok)
    return null
  const json = await res.json()
  return json?.success ? json : null
}

export interface AthleteSearchResult {
  id: number
  name: string
  activityCount: number
  followerCount: number
  territoriesOwned: number
  totalAreaOwned: number
}

/** Search athletes by name; empty/short query returns a discover list (#971). */
export async function searchAthletes(q: string): Promise<AthleteSearchResult[] | null> {
  const res = await apiFetch(`/api/users/search?q=${encodeURIComponent(q)}`, { headers: authHeaders() })
  if (!res.ok)
    return null
  const json = await res.json()
  return json?.success ? json.athletes : null
}

/** Fetch achievement definitions merged with a user's progress (#982). */
export async function fetchAchievements(userId: number): Promise<{ achievements: any[], meta: any } | null> {
  // Zero is the guest sentinel, not an athlete (see fetchSavedTrails).
  if (!Number.isInteger(userId) || userId <= 0)
    return null
  const res = await apiFetch(`/api/users/${userId}/achievements`)
  if (!res.ok)
    return null
  const json = await res.json()
  return json?.success ? json : null
}

/** Fetch a public athlete profile (identity, stats, social counts, recent activities). */
export async function fetchAthlete(userId: number): Promise<any | null> {
  const res = await apiFetch(`/api/users/${userId}`, { headers: authHeaders() })
  if (!res.ok)
    return null
  const json = await res.json()
  return json?.success ? json : null
}

/** Fetch a user's social graph (counts + id lists). Public read. */
export async function fetchFollows(userId: number): Promise<FollowsResult | null> {
  if (!Number.isInteger(userId) || userId <= 0)
    return null
  const res = await apiFetch(`/api/users/${userId}/follows`, { headers: authHeaders() })
  if (!res.ok)
    return null
  const json = await res.json()
  return json?.success ? json : null
}

/** Follow or unfollow a user; returns the new state + the target's follower count. */
export async function toggleFollow(targetId: number, following: boolean): Promise<{ success: boolean, following?: boolean, followerCount?: number }> {
  await ensureSession()
  const res = await apiFetch(`/api/users/${targetId}/follow`, {
    method: following ? 'PUT' : 'DELETE',
    headers: authHeaders(),
    body: JSON.stringify({}),
  })
  return res.json()
}

/** Block or unblock an athlete. Blocking also removes follow relationships. */
export async function toggleBlock(targetId: number, blocked: boolean): Promise<{ success: boolean, blocked?: boolean, error?: string }> {
  await ensureSession()
  const res = await apiFetch(`/api/users/${targetId}/block`, {
    method: blocked ? 'PUT' : 'DELETE',
    headers: authHeaders(),
    body: JSON.stringify({}),
  })
  return res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }))
}

/** Submit a deduplicated moderation report. */
export async function reportContent(payload: {
  subject_type: 'user' | 'activity' | 'comment' | 'trail_review' | 'territory'
  subject_id: number
  reason: 'harassment' | 'spam' | 'unsafe' | 'cheating' | 'privacy' | 'other'
  details?: string
}): Promise<{ success: boolean, alreadyReported?: boolean, error?: string }> {
  await ensureSession()
  const res = await apiFetch('/api/reports', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  })
  return res.json().catch(() => ({ success: false, error: `HTTP ${res.status}` }))
}

/** Claim a new territory from a completed closed-loop activity. */
export async function claimTerritory(activityId: number, userId: number): Promise<ClaimResult> {
  await ensureSession()
  const res = await apiFetch('/api/territories/claim', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ activity_id: activityId, user_id: userId }),
  })
  const result = await res.json().catch(() => null)
  if (res.status >= 500) {
    const error = new Error(result?.error || 'Territory claim failed') as Error & { retryable?: boolean }
    error.retryable = true
    throw error
  }
  return result
}

/** Process conquests for an activity that ran through enemy territory. */
export async function processConquest(activityId: number, userId: number, targetTerritoryId?: number | null): Promise<ConquestResult> {
  await ensureSession()
  const res = await apiFetch('/api/territories/process-conquest', {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      activity_id: activityId,
      user_id: userId,
      ...(targetTerritoryId ? { target_territory_id: targetTerritoryId } : {}),
    }),
  })
  const result = await res.json().catch(() => null)
  if (res.status >= 500) {
    const error = new Error(result?.error || 'Territory battle failed') as Error & { retryable?: boolean }
    error.retryable = result?.retryable !== false
    throw error
  }
  return result
}

export interface RunResult {
  activityId: number | null
  claim?: ClaimResult
  conquest?: ConquestResult
  /** The activity was saved, but server-side telemetry verification excluded it from capture. */
  captureIneligible?: boolean
  integrityReason?: string | null
  queued?: boolean
  error?: string
}

/**
 * Persist a recorded run and run the territory engine end-to-end: create the
 * Activity, then attempt a closed-loop claim and a route-intersection conquest.
 */
export async function persistRunAndProcess(
  payload: ActivityPayload,
  options: { queueOnFailure?: boolean } = {},
): Promise<RunResult> {
  const queueOnFailure = options.queueOnFailure ?? true
  let activity: CreatedActivity | null = null
  try {
    activity = await createActivity(payload)
    if (!activity)
      throw new Error('The activity API refused the upload')

    if (!['web_gps', 'native_gps'].includes(payload.recording_source ?? '') || payload.game_mode !== 'capture')
      return { activityId: activity.id }

    if (!activity.captureEligible) {
      return {
        activityId: activity.id,
        captureIneligible: true,
        integrityReason: activity.integrityReason || 'Route telemetry was not eligible for territory capture',
      }
    }

    const claim = await claimTerritory(activity.id, payload.user_id)
    const conquest = await processConquest(activity.id, payload.user_id, payload.target_territory_id)
    return { activityId: activity.id, claim, conquest }
  }
  catch (error) {
    // Until the activity is saved, this recording exists only on this device,
    // and the recorder clears its copy once the save is over. So it is kept
    // whatever went wrong: a 401 after a password change, or a 422, used to
    // throw the run away. Once saved, a failure belongs to the territory
    // engine, and only a transient one is worth replaying.
    const retryable = (error as Error & { retryable?: boolean })?.retryable !== false
    if (queueOnFailure && payload.upload_id && (!activity || retryable)) {
      const { enqueueRun } = await import('./run-upload-queue')
      await enqueueRun(payload, error)
      return {
        activityId: null,
        queued: true,
        error: queuedRunMessage(error),
      }
    }
    throw error
  }
}

/** Explain a completed recording without treating an integrity exclusion as a failed save. */
export function runSaveMessage(result: RunResult): string {
  if (!result.activityId)
    return result.error || 'Activity could not be saved'
  if (result.captureIneligible)
    return `Activity saved, but territory capture did not count: ${result.integrityReason || 'Route telemetry was not eligible'}`
  return 'Activity saved'
}

/** Build a short toast message from a run result, or null if nothing happened. */
export function runResultMessage(result: RunResult): string | null {
  const parts: string[] = []

  const count = result.conquest?.conqueredCount ?? 0
  if (count > 0) {
    const plural = count > 1 ? 'territories' : 'territory'
    parts.push(`Conquered ${count} ${plural}!`)
  }

  const defended = result.conquest?.defended ?? []
  if (defended.length > 0)
    parts.push(`Defended ${defended.map(d => d.name).join(', ')}!`)

  if (result.claim?.success && result.claim.territory) {
    const km2 = (result.claim.territory.areaSize / 1000000).toFixed(2)
    parts.push(`Claimed new territory: ${km2} km²!`)
  }

  const contested = result.conquest?.contested ?? []
  if (contested.length > 0)
    parts.push(`Attacked ${contested.map(c => c.name).join(', ')}. Run through to conquer!`)

  // Authoritative XP from the server (#947), summed across claim + conquest.
  const xpGained = (result.claim?.xpGained ?? 0) + (result.conquest?.xpGained ?? 0)
  if (xpGained > 0)
    parts.push(`+${xpGained} XP!`)

  return parts.length ? parts.join(' ') : null
}

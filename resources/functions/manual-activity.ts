import { paceString, parseDurationToSeconds } from './duration'

export const MANUAL_ACTIVITY_TYPES = ['Trail Run', 'Hike', 'Walk', 'Bike'] as const
export const ACTIVITY_VISIBILITIES = ['public', 'followers', 'private'] as const

export interface ManualActivityInput {
  type: string
  distance: string
  duration: string
  elevation: string
  trailId: string
  date: string
  notes: string
  visibility: string
}

export interface ManualActivityPayload {
  /**
   * Omitted when the caller does not know it.
   *
   * `ActivityStoreAction` takes the actor from `Auth.user()` and ignores this
   * field — "the authenticated session is the only source of actor identity" —
   * so a client that holds a token but no id has nothing to prove and should
   * not be stopped. The web feed passes the id it already has; a native screen
   * entered without one passes null.
   */
  user_id?: number
  trail_id: number | null
  activity_type: string
  distance: number
  duration: string
  moving_time: string
  pace: string
  elevation: number
  notes?: string
  visibility: string
  completed_at: string
  upload_id: string
  recording_source: 'manual'
  game_mode: 'none'
}

export type ManualActivityResult =
  | { ok: true, payload: ManualActivityPayload, movingSeconds: number }
  | { ok: false, error: string }

export function todayLocal(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/** Build the canonical GPS-free activity request used by web and native entry. */
export function buildManualActivity(
  input: ManualActivityInput,
  userId: number | null,
  options: { now?: Date, uploadId?: string } = {},
): ManualActivityResult {
  const now = options.now ?? new Date()
  const distance = Number.parseFloat(input.distance)
  const duration = input.duration.trim()
  const movingSeconds = parseDurationToSeconds(duration)
  const elevation = Math.round(Number.parseFloat(input.elevation || '0'))

  if (!(MANUAL_ACTIVITY_TYPES as readonly string[]).includes(input.type))
    return { ok: false, error: 'Pick an activity type' }
  // `null` means "the session decides"; a number means the caller claims to
  // know, and a bad one is a signed-out web form rather than a missing param.
  if (userId !== null && (!Number.isFinite(userId) || userId <= 0))
    return { ok: false, error: 'Sign in before saving an activity' }
  if (!Number.isFinite(distance) || distance <= 0)
    return { ok: false, error: 'Distance must be a positive number of miles' }
  if (movingSeconds === null)
    return { ok: false, error: 'Duration must look like 45:30 or 1:45:30' }
  if (!Number.isFinite(elevation) || elevation < 0)
    return { ok: false, error: 'Elevation must be a non-negative number of feet' }
  if (!(ACTIVITY_VISIBILITIES as readonly string[]).includes(input.visibility))
    return { ok: false, error: 'Pick who can see the activity' }

  const trailId = input.trailId.trim() ? Number(input.trailId) : null
  if (trailId !== null && (!Number.isInteger(trailId) || trailId <= 0))
    return { ok: false, error: 'Trail must be a positive whole number' }

  let completedAt = now.toISOString()
  if (input.date && input.date !== todayLocal(now)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date))
      return { ok: false, error: 'Date must look like YYYY-MM-DD' }
    const [year, month, day] = input.date.split('-').map(Number)
    const chosen = new Date(`${input.date}T12:00:00`)
    if (!Number.isFinite(chosen.getTime())
      || chosen.getFullYear() !== year
      || chosen.getMonth() + 1 !== month
      || chosen.getDate() !== day)
      return { ok: false, error: 'Date is not valid' }
    completedAt = chosen.toISOString()
  }

  const notes = input.notes.trim()
  return {
    ok: true,
    movingSeconds,
    payload: {
      ...(userId === null ? {} : { user_id: userId }),
      trail_id: trailId,
      activity_type: input.type,
      distance: Number(distance.toFixed(2)),
      duration,
      moving_time: duration,
      pace: paceString(distance, movingSeconds),
      elevation,
      notes: notes || undefined,
      visibility: input.visibility,
      completed_at: completedAt,
      upload_id: options.uploadId ?? `manual:${now.getTime()}:${Math.random().toString(36).slice(2)}`,
      recording_source: 'manual',
      game_mode: 'none',
    },
  }
}

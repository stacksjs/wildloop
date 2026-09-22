import { state } from 'stx'
import { createActivity } from '../assets/scripts/game-api'
import { paceString, parseDurationToSeconds } from '../functions/duration'
import { loadActivityVisibilityDefault } from '../assets/scripts/privacy-defaults'

/**
 * Manual activity entry (#955) - log a run/hike after the fact with no GPS
 * track. Reuses POST /api/activities (gpx optional); pace is computed from
 * distance + duration, and the created row (with its real backend id) is
 * inserted into the feed store optimistically.
 */

interface ManualStoreLike {
  currentUserId: () => number
  findUser: (id: number) => { name: string } | undefined
  findTrail: (id: number) => { id: number, name: string } | undefined
  addActivity: (activity: Record<string, unknown>) => void
}

const MANUAL_TYPES = ['Trail Run', 'Hike', 'Walk', 'Bike']

export function useManualActivity(wl: ManualStoreLike | null) {
  const manualOpen = state(false)
  const submitting = state(false)
  const manualError = state<string | null>(null)

  const mType = state('Trail Run')
  const mDistance = state('')
  const mDuration = state('')
  const mElevation = state('')
  const mTrailId = state('')
  const mDate = state('')
  const mNotes = state('')
  const mVisibility = state('followers')

  // Today in the athlete's own calendar, as a date input writes it. The box
  // opens on it rather than blank, which read as a broken field.
  function todayLocal(): string {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }

  function openManualEntry() {
    mType.set('Trail Run')
    mDistance.set('')
    mDuration.set('')
    mElevation.set('')
    mTrailId.set('')
    mDate.set(todayLocal())
    mNotes.set('')
    mVisibility.set('followers')
    manualError.set(null)
    manualOpen.set(true)
    void loadActivityVisibilityDefault().then((value) => {
      if (manualOpen()) mVisibility.set(value)
    })
  }

  function closeManualEntry() {
    manualOpen.set(false)
    manualError.set(null)
  }

  async function submitManualEntry() {
    if (!wl || submitting())
      return
    const distance = Number.parseFloat(mDistance())
    const duration = mDuration().trim()
    const seconds = parseDurationToSeconds(duration)
    const elevation = Math.round(Number.parseFloat(mElevation() || '0'))

    if (!MANUAL_TYPES.includes(mType())) {
      manualError.set('Pick an activity type')
      return
    }
    if (!Number.isFinite(distance) || distance <= 0) {
      manualError.set('Distance must be a positive number of miles')
      return
    }
    if (seconds === null) {
      manualError.set('Duration must look like 45:30 or 1:45:30')
      return
    }
    if (!Number.isFinite(elevation) || elevation < 0) {
      manualError.set('Elevation must be a non-negative number of feet')
      return
    }

    const trailId = mTrailId() ? Number(mTrailId()) : null
    const trail = trailId ? wl.findTrail(trailId) : undefined
    const pace = paceString(distance, seconds)
    // Date-only input → pin to midday local so timezone shifts can't move the day.
    // Today is logged as now, so a morning entry is not stamped in the future.
    const completedAt = mDate() && mDate() !== todayLocal()
      ? new Date(`${mDate()}T12:00:00`).toISOString()
      : new Date().toISOString()
    const notes = mNotes().trim()

    submitting.set(true)
    manualError.set(null)
    const created = await createActivity({
      user_id: wl.currentUserId(),
      trail_id: trailId,
      activity_type: mType(),
      distance: Number(distance.toFixed(2)),
      duration,
      moving_time: duration,
      pace,
      elevation,
      notes: notes || undefined,
      visibility: mVisibility(),
      completed_at: completedAt,
      upload_id: `manual:${crypto.randomUUID()}`,
      recording_source: 'manual',
      game_mode: 'none',
    }).catch((error) => {
      manualError.set(error instanceof Error ? error.message : 'Could not save the activity')
      return null
    })
    submitting.set(false)

    if (!created) {
      manualError.set('Could not save the activity. Is the API running?')
      return
    }

    const me = wl.findUser(wl.currentUserId())
    const when = new Date(completedAt).toLocaleDateString()
    wl.addActivity({
      id: created.id,
      user_id: wl.currentUserId(),
      userName: me?.name ?? 'You',
      trail_id: trailId,
      trail_name: trail?.name ?? `${mType()} Activity`,
      title: trail ? `${mType()} at ${trail.name}` : `${mType()}, ${when}`,
      activityType: mType(),
      distance: Number(distance.toFixed(2)),
      duration,
      moving_time: duration,
      pace,
      elevation_gain: elevation,
      calories: Math.round(seconds / 60 * 10),
      heartRateAvg: null,
      heartRateMax: null,
      cadence: null,
      splits: [],
      kudos_count: 0,
      comments: [],
      notes,
      visibility: mVisibility(),
      hasGps: false,
    })
    manualOpen.set(false)
  }

  return {
    manualOpen,
    submitting,
    manualError,
    mType,
    mDistance,
    mDuration,
    mElevation,
    mTrailId,
    mDate,
    mNotes,
    mVisibility,
    openManualEntry,
    closeManualEntry,
    submitManualEntry,
  }
}

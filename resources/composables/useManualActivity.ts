import { state } from 'stx'
import { createActivity } from '../assets/scripts/game-api'
import { loadActivityVisibilityDefault } from '../assets/scripts/privacy-defaults'
import { estimateCalories } from '../functions/calories'
import { buildManualActivity, MANUAL_ACTIVITY_TYPES, todayLocal } from '../functions/manual-activity'

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
    const built = buildManualActivity({
      type: mType(),
      distance: mDistance(),
      duration: mDuration(),
      elevation: mElevation(),
      trailId: mTrailId(),
      date: mDate(),
      notes: mNotes(),
      visibility: mVisibility(),
    }, wl.currentUserId(), { uploadId: `manual:${crypto.randomUUID()}` })
    if (built.ok === false) {
      manualError.set(built.error)
      return
    }
    const { payload, movingSeconds } = built
    const trailId = payload.trail_id
    const trail = trailId ? wl.findTrail(trailId) : undefined

    submitting.set(true)
    manualError.set(null)
    const created = await createActivity(payload).catch((error) => {
      manualError.set(error instanceof Error ? error.message : 'Could not save the activity')
      return null
    })
    submitting.set(false)

    if (!created) {
      manualError.set('Could not save the activity. Is the API running?')
      return
    }

    const me = wl.findUser(wl.currentUserId())
    const when = new Date(payload.completed_at).toLocaleDateString()
    wl.addActivity({
      id: created.id,
      user_id: wl.currentUserId(),
      userName: me?.name ?? 'You',
      trail_id: trailId,
      trail_name: trail?.name ?? `${mType()} Activity`,
      title: trail ? `${mType()} at ${trail.name}` : `${mType()}, ${when}`,
      activityType: mType(),
      distance: payload.distance,
      duration: payload.duration,
      moving_time: payload.moving_time,
      pace: payload.pace,
      elevation_gain: payload.elevation,
      calories: estimateCalories({
        activityType: mType(),
        distanceMiles: payload.distance,
        movingTime: movingSeconds,
        elevationGainFeet: payload.elevation,
      }),
      heartRateAvg: null,
      heartRateMax: null,
      cadence: null,
      splits: [],
      kudos_count: 0,
      comments: [],
      notes: payload.notes ?? '',
      visibility: payload.visibility,
      hasGps: false,
    })
    manualOpen.set(false)
  }

  return {
    manualTypes: MANUAL_ACTIVITY_TYPES,
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

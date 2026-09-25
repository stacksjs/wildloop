// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// Persists a recorded run as an Activity row. The recorder POSTs a GPS track
// (GeoJSON LineString / JSON coords) in `gpx_data`; that payload is what the
// territory engine (claim / process-conquest) later reads. Snake_case keys
// match the ORM's column-based attributes.
import { Auth } from '@stacksjs/auth'
import { parseDurationToSeconds } from '../../../resources/functions/duration'

import { evaluateAchievementsForUser } from '../Achievement/EvaluateAchievementsAction'
import { durationLabel, evaluateTrackIntegrity, isLiveGpsSource, type RecordingSource } from '../../../resources/functions/activity-integrity'
import { integrityFlagsJson, verifyAgainstHistory } from '../../Support/activityIntegrityCheck'
import UserPrivacySetting from '../../Models/UserPrivacySetting'

const ACTIVITY_TYPES = ['Trail Run', 'Hike', 'Walk', 'Bike']
const VISIBILITIES = ['public', 'followers', 'private']
const RECORDING_SOURCES: RecordingSource[] = ['web_gps', 'native_gps', 'simulation', 'manual', 'file_import', 'garmin']
const GAME_MODES = ['capture', 'free', 'none']

export default new Action({
  name: 'Activity Store',
  description: 'Create an activity (a recorded run/hike) with its GPS track',
  method: 'POST',

  async handle(request) {
    // The authenticated session is the only source of actor identity.
    const userId = (await Auth.user().catch(() => null))?.id
    const activityType = request.get<string>('activity_type') || 'Trail Run'
    const distance = boundedNumber(request.get('distance'), 0, 1000)
    const duration = durationString(request.get('duration'))
    const recordingSource = request.get<RecordingSource>('recording_source')
      ?? (request.get('gpx_data') ? 'file_import' : 'manual')
    const gameMode = request.get<string>('game_mode') ?? 'none'
    const uploadId = request.get<string>('upload_id')?.trim() || null

    // Field validation (#977): malformed input → 422 with a field-keyed map.
    const fields: Record<string, string> = {}
    if (!userId)
      fields.user_id = 'required: authenticated session'
    if (!ACTIVITY_TYPES.includes(activityType))
      fields.activity_type = `must be one of: ${ACTIVITY_TYPES.join(', ')}`
    if (distance === null)
      fields.distance = 'required: miles as a number between 0 and 1000'
    if (duration === null)
      fields.duration = 'required: a MM:SS or H:MM:SS duration'
    if (!RECORDING_SOURCES.includes(recordingSource))
      fields.recording_source = `must be one of: ${RECORDING_SOURCES.join(', ')}`
    if (!GAME_MODES.includes(gameMode))
      fields.game_mode = `must be one of: ${GAME_MODES.join(', ')}`
    if (uploadId && (uploadId.length > 100 || !/^[A-Za-z0-9._:-]+$/.test(uploadId)))
      fields.upload_id = 'must be 100 characters or fewer using letters, numbers, dot, underscore, colon, or dash'

    const movingTime = request.get('moving_time')
    if (movingTime !== undefined && movingTime !== null && durationString(movingTime) === null)
      fields.moving_time = 'must be a MM:SS or H:MM:SS duration'
    const elevationRaw = request.get('elevation')
    const elevation = elevationRaw === undefined || elevationRaw === null ? 0 : boundedNumber(elevationRaw, 0, 100000)
    if (elevation === null)
      fields.elevation = 'must be feet as a number between 0 and 100000'
    const trailIdRaw = request.get('trail_id')
    const trailId = trailIdRaw === undefined || trailIdRaw === null ? null : positiveInt(trailIdRaw)
    if (trailIdRaw !== undefined && trailIdRaw !== null && trailId === null)
      fields.trail_id = 'must be a positive integer trail id'
    const gpxData = request.get('gpx_data')
    if (gpxData !== undefined && gpxData !== null && (typeof gpxData !== 'string' || gpxData.length > 2_000_000))
      fields.gpx_data = 'must be a GeoJSON/JSON string under 2MB'
    const completedAt = request.get('completed_at')
    if (completedAt !== undefined && completedAt !== null && (typeof completedAt !== 'string' || Number.isNaN(Date.parse(completedAt))))
      fields.completed_at = 'must be a parseable date string'
    const privacy = userId
      ? await UserPrivacySetting.where('user_id', '=', userId).first().catch(() => null)
      : null
    const visibility = request.get<string>('visibility') ?? privacy?.default_activity_visibility ?? 'followers'
    if (!VISIBILITIES.includes(visibility))
      fields.visibility = `must be one of: ${VISIBILITIES.join(', ')}`

    const integrity = evaluateTrackIntegrity({
      gpxData: typeof gpxData === 'string' ? gpxData : null,
      source: recordingSource,
      activityType,
      completedAt: typeof completedAt === 'string' ? completedAt : null,
    })
    if (!integrity.valid)
      fields.gpx_data = integrity.reason ?? 'Track telemetry failed integrity checks'

    if (Object.keys(fields).length)
      return response.json({ success: false, error: 'Validation failed', fields }, 422)

    // Splits arrive as an array of { mile, pace, elev } (or a pre-encoded JSON
    // string); store as JSON text. Cap the count to keep payloads sane.
    const rawSplits = request.get<unknown>('splits')
    let splitsJson: string | null = null
    if (Array.isArray(rawSplits) && rawSplits.length > 0)
      splitsJson = JSON.stringify(rawSplits.slice(0, 200))
    else if (typeof rawSplits === 'string' && rawSplits.startsWith('['))
      splitsJson = rawSplits

    try {
      if (uploadId) {
        const existing = await Activity
          .where('user_id', '=', userId)
          .where('upload_id', '=', uploadId)
          .first()
        if (existing) {
          return response.json({
            success: true,
            alreadyProcessed: true,
            activity: activityResponse(existing),
          })
        }
      }

      // Everything so far judged this track on its own. The athlete's other
      // activities decide the rest: nobody is in two places at once, and
      // nobody records the same trace twice.
      const claimedEligible = integrity.captureEligible && gameMode === 'capture'
      const verdict = await verifyAgainstHistory({
        userId,
        integrity,
        completedAt: typeof completedAt === 'string' ? completedAt : null,
        captureEligible: claimedEligible,
      })
      const captureEligible = verdict.captureEligible
      const serverDistance = isLiveGpsSource(recordingSource) && integrity.distanceMiles !== null
        ? Number(integrity.distanceMiles.toFixed(2))
        : distance
      const serverDuration = isLiveGpsSource(recordingSource) && integrity.durationSeconds !== null
        ? durationLabel(integrity.durationSeconds)
        : duration
      // The device timer can include time before the first or after the last
      // GPS fix. Moving time must fit the authoritative elapsed interval.
      const submittedMovingTime = durationString(movingTime)
      const elapsedSeconds = parseDurationToSeconds(serverDuration!)!
      const movingSeconds = submittedMovingTime === null ? null : parseDurationToSeconds(submittedMovingTime)
      const serverMovingTime = movingSeconds !== null && movingSeconds > elapsedSeconds
        ? serverDuration
        : submittedMovingTime
      const paceSeconds = integrity.durationSeconds && integrity.distanceMiles && integrity.distanceMiles > 0.01
        ? Math.round(integrity.durationSeconds / integrity.distanceMiles)
        : null
      const serverPace = isLiveGpsSource(recordingSource) && paceSeconds !== null
        ? `${Math.floor(paceSeconds / 60)}:${String(paceSeconds % 60).padStart(2, '0')}`
        : request.get<string>('pace') ?? null

      const activity = await Activity.create({
        user_id: userId,
        trail_id: trailId,
        activity_type: activityType,
        distance: serverDistance,
        duration: serverDuration,
        moving_time: serverMovingTime,
        pace: serverPace,
        elevation,
        kudos_count: 0,
        notes: request.get<string>('notes') ?? null,
        gpx_data: (gpxData as string | undefined) ?? null,
        splits: splitsJson,
        visibility,
        upload_id: uploadId,
        recording_source: recordingSource,
        game_mode: gameMode,
        capture_eligible: captureEligible,
        integrity_status: integrity.status,
        integrity_reason: captureEligible ? null : (verdict.reason ?? integrity.reason),
        anomaly_score: integrity.anomalyScore,
        integrity_flags: integrityFlagsJson(integrity, verdict.findings),
        track_fingerprint: integrity.fingerprint,
        review_state: verdict.reviewState,
        completed_at: (completedAt as string | undefined) ?? new Date().toISOString(),
      })

      // Unlock engine hook (#982) - best-effort, never blocks the store.
      await evaluateAchievementsForUser(userId).catch((err: unknown) =>
        console.error('[achievements] evaluate after activity failed:', err))

      return response.json({
        success: true,
        activity: activityResponse(activity),
      }, 201)
    }
    catch (error) {
      console.error('Error creating activity:', error)
      return response.json({ success: false, error: 'Failed to create activity' }, 500)
    }
  },
})

function activityResponse(activity: any) {
  return {
    id: activity.id,
    userId: activity.user_id,
    trailId: activity.trail_id,
    activityType: activity.activity_type,
    distance: activity.distance,
    duration: activity.duration,
    movingTime: activity.moving_time,
    pace: activity.pace,
    elevation: activity.elevation,
    completedAt: activity.completed_at,
    visibility: activity.visibility ?? 'public',
    hasGps: !!activity.gpx_data,
    recordingSource: activity.recording_source ?? 'manual',
    gameMode: activity.game_mode ?? 'none',
    captureEligible: !!activity.capture_eligible,
    integrityStatus: activity.integrity_status ?? 'unverified',
    integrityReason: activity.integrity_reason ?? null,
  }
}

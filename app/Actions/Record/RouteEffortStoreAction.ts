// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// POST /api/route-efforts (auth) - announce an attempt, or file a finished one.
//
// The athlete is the session user, never the body: a record is a claim about a
// person, and letting a request name someone else would let anyone file a
// fraudulent time under a rival's account.

import { Auth } from '@stacksjs/auth'
import Activity from '../../Models/Activity'
import RouteEffort from '../../Models/RouteEffort'
import Trail from '../../Models/Trail'

import {
  elapsedSeconds,
  evidenceIsSufficient,
  normalizeEvidenceUrl,
  normalizeTrackerUrl,
  routeIsRankable,
} from '../../../resources/functions/route-records'
import { asCategory, asDirection, asStyle, shapeEfforts } from './record-support'

export default new Action({
  name: 'Route Effort Store',
  description: 'File a record attempt on a route, in progress or already finished',
  method: 'POST',

  async handle(request) {
    const userId = (await Auth.user().catch(() => null))?.id
    if (!userId)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const trailId = positiveInt(request.get('trail_id') ?? request.get('trailId'))
    const activityId = positiveInt(request.get('activity_id') ?? request.get('activityId'))
    const style = asStyle(request.get('style'))
    const category = asCategory(request.get('category'))
    const direction = asDirection(request.get('direction') ?? 'standard')
    const teamSize = boundedNumber(request.get('team_size') ?? request.get('teamSize') ?? 1, 1, 20)
    const startedAt = request.get<string>('started_at') ?? request.get<string>('startedAt') ?? ''
    const rawFinishedAt = request.get<string>('finished_at') ?? request.get<string>('finishedAt') ?? ''
    const tripReport = boundedString(request.get('trip_report') ?? request.get('tripReport'), 20_000)
    const evidenceUrl = normalizeEvidenceUrl(request.get('evidence_url') ?? request.get('evidenceUrl'))
    const trackerUrl = normalizeTrackerUrl(request.get('tracker_url') ?? request.get('trackerUrl'))
    const gpxUrl = normalizeTrackerUrl(request.get('gpx_url') ?? request.get('gpxUrl'))

    const fields: Record<string, string> = {}
    if (!trailId)
      fields.trail_id = 'required: the route this attempt is on'
    if (!style)
      fields.style = 'must be one of: supported, self_supported, unsupported'
    if (!category)
      fields.category = 'must be one of: mens, womens, nonbinary'
    if (!direction)
      fields.direction = 'must be one of: standard, reverse, yo_yo'
    if (teamSize === null || !Number.isInteger(teamSize))
      fields.team_size = 'must be a whole number between 1 and 20'

    const startMs = Date.parse(startedAt)
    if (!Number.isFinite(startMs))
      fields.started_at = 'required: an ISO 8601 timestamp'
    // A start an hour into the future is a clock skew; a start next week is
    // somebody reserving a record they have not run.
    else if (startMs > Date.now() + 3_600_000)
      fields.started_at = 'cannot be in the future'

    if (Object.keys(fields).length)
      return response.json({ success: false, error: 'Validation failed', fields }, 422)

    try {
      const trail = await Trail.find(trailId as number)
      if (!trail)
        return response.json({ success: false, error: 'Route not found' }, 404)

      // A route too short or too flat to be worth racing does not get a board.
      // Checked server-side because the form's copy is a courtesy, not a gate.
      const rankable = routeIsRankable(trail)
      if (!rankable.eligible)
        return response.json({ success: false, error: rankable.reason, fields: { trail_id: rankable.reason as string } }, 422)

      // An unfinished attempt is a real, publishable object: it is what the
      // tracking board shows. Everything below only applies once there is a
      // finish time to rank.
      const finished = rawFinishedAt.trim().length > 0
      let seconds: number | null = null
      if (finished) {
        seconds = elapsedSeconds(startedAt, rawFinishedAt)
        if (seconds === null) {
          return response.json({
            success: false,
            error: 'Validation failed',
            fields: { finished_at: 'must be after the start, by at least a minute and less than 100 days' },
          }, 422)
        }
      }

      // A Wildloop recording can back the claim, but only the athlete's own:
      // pointing at somebody else's activity would borrow their trace.
      if (activityId) {
        const activity = await Activity.find(activityId)
        if (!activity)
          return response.json({ success: false, error: 'Activity not found' }, 404)
        if (activity.user_id !== userId)
          return response.json({ success: false, error: 'That activity belongs to another athlete' }, 403)
        const existing = await RouteEffort.where('activity_id', '=', activityId).first()
        if (existing)
          return response.json({ success: false, error: 'That activity has already been filed as a record attempt' }, 409)
      }

      const status = finished ? 'pending' : 'in_progress'
      if (!evidenceIsSufficient({ status, activityId, evidenceUrl, gpxUrl })) {
        return response.json({
          success: false,
          error: 'Validation failed',
          fields: { evidence_url: 'a finished attempt needs a GPS file, a Wildloop activity, or a link to the recording on Strava, Garmin, Suunto, COROS, TrainingPeaks, komoot, or RideWithGPS' },
        }, 422)
      }

      const effort = await RouteEffort.forceCreate({
        trail_id: trailId,
        user_id: userId,
        activity_id: activityId ?? null,
        style,
        category,
        direction,
        team_size: teamSize,
        // Never born verified. Even an effort with a perfect trace waits for a
        // human, because the whole value of the board is that somebody looked.
        status,
        started_at: new Date(startMs).toISOString(),
        finished_at: finished ? new Date(Date.parse(rawFinishedAt)).toISOString() : null,
        elapsed_seconds: seconds,
        evidence_url: evidenceUrl,
        gpx_url: gpxUrl,
        tracker_url: trackerUrl,
        trip_report: tripReport,
        reviewed_by: null,
        reviewed_at: null,
        review_note: null,
      })

      // Re-read rather than shaping what `forceCreate` handed back: it returns
      // a partial row, so the response reported a filed record with no status
      // and no time even though the insert was correct. The row that comes
      // back from the table is also the one carrying any column default.
      const stored = await RouteEffort.find(effort.id)
      const [shaped] = await shapeEfforts([stored ?? effort])
      return response.json({ success: true, effort: shaped }, 201)
    }
    catch (error) {
      console.error('[records] store failed:', error)
      return response.json({ success: false, error: 'Failed to file the attempt' }, 500)
    }
  },
})

// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// PATCH /api/route-efforts/{id} (auth) - close out or amend your own attempt.
//
// This is how an `in_progress` row becomes a time: the athlete comes back and
// supplies a finish and their evidence. It is also how a DNF is recorded,
// which matters — an attempt that quietly disappears from the tracking board
// teaches people not to announce the next one.

import { Auth } from '@stacksjs/auth'
import RouteEffort from '../../Models/RouteEffort'

import {
  elapsedSeconds,
  evidenceIsSufficient,
  normalizeEvidenceUrl,
  normalizeTrackerUrl,
} from '../../../resources/functions/route-records'
import { shapeEfforts } from './record-support'

export default new Action({
  name: 'Route Effort Update',
  description: 'Finish, DNF, or amend your own record attempt',
  method: 'PATCH',

  async handle(request) {
    const userId = (await Auth.user().catch(() => null))?.id
    if (!userId)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const effortId = positiveInt(request.get('id'))
    if (!effortId)
      return response.json({ success: false, error: 'Validation failed', fields: { id: 'required: a positive integer effort id' } }, 422)

    try {
      const effort = await RouteEffort.find(effortId)
      if (!effort)
        return response.json({ success: false, error: 'Attempt not found' }, 404)
      if (effort.user_id !== userId)
        return response.json({ success: false, error: 'That attempt belongs to another athlete' }, 403)

      // A verified time is the site's statement, not the athlete's, and it is
      // what other people's rankings were computed against. Changing it needs
      // a reviewer, so the athlete's route out is to contact one.
      if (effort.status === 'verified') {
        return response.json({
          success: false,
          error: 'A verified record cannot be edited. Ask a reviewer to reopen it if something is wrong.',
        }, 409)
      }

      const patch: Record<string, unknown> = {}
      const fields: Record<string, string> = {}

      const rawFinishedAt = request.get<string>('finished_at') ?? request.get<string>('finishedAt')
      const rawOutcome = request.get<string>('outcome')

      if (rawOutcome === 'dnf') {
        // A DNF keeps the start (it happened) and drops the clock (there is
        // nothing to rank), which is what makes it distinct from a deletion.
        patch.status = 'dnf'
        patch.finished_at = null
        patch.elapsed_seconds = null
      }
      else if (typeof rawFinishedAt === 'string' && rawFinishedAt.trim()) {
        const seconds = elapsedSeconds(effort.started_at, rawFinishedAt)
        if (seconds === null)
          fields.finished_at = 'must be after the start, by at least a minute and less than 100 days'
        else {
          patch.finished_at = new Date(Date.parse(rawFinishedAt)).toISOString()
          patch.elapsed_seconds = seconds
          // Re-filing after a rejection puts the claim back in the queue
          // rather than leaving it stamped with the old decision.
          patch.status = 'pending'
          patch.reviewed_by = null
          patch.reviewed_at = null
          patch.review_note = null
        }
      }

      if (request.get('trip_report') !== undefined || request.get('tripReport') !== undefined)
        patch.trip_report = boundedString(request.get('trip_report') ?? request.get('tripReport'), 20_000)

      if (request.get('evidence_url') !== undefined || request.get('evidenceUrl') !== undefined) {
        const raw = request.get('evidence_url') ?? request.get('evidenceUrl')
        const normalized = normalizeEvidenceUrl(raw)
        if (raw && !normalized)
          fields.evidence_url = 'must be an https link to the recording on Strava, Garmin, Suunto, COROS, TrainingPeaks, komoot, or RideWithGPS'
        else
          patch.evidence_url = normalized
      }

      if (request.get('gpx_url') !== undefined || request.get('gpxUrl') !== undefined)
        patch.gpx_url = normalizeTrackerUrl(request.get('gpx_url') ?? request.get('gpxUrl'))

      if (request.get('tracker_url') !== undefined || request.get('trackerUrl') !== undefined)
        patch.tracker_url = normalizeTrackerUrl(request.get('tracker_url') ?? request.get('trackerUrl'))

      if (Object.keys(fields).length)
        return response.json({ success: false, error: 'Validation failed', fields }, 422)
      if (!Object.keys(patch).length)
        return response.json({ success: false, error: 'Nothing to update' }, 422)

      // Re-check evidence against the merged row, not the patch: dropping the
      // only link off an already-finished claim has to fail the same way as
      // never supplying one.
      const merged = { ...effort, ...patch } as any
      if (!evidenceIsSufficient({
        status: merged.status,
        activityId: merged.activity_id,
        evidenceUrl: merged.evidence_url,
        gpxUrl: merged.gpx_url,
      })) {
        return response.json({
          success: false,
          error: 'Validation failed',
          fields: { evidence_url: 'a finished attempt needs a GPS file, a Wildloop activity, or a link to the recording' },
        }, 422)
      }

      await RouteEffort.where('id', '=', effortId).update(patch)
      const updated = await RouteEffort.find(effortId)
      const [shaped] = await shapeEfforts([updated])
      return response.json({ success: true, effort: shaped })
    }
    catch (error) {
      console.error('[records] update failed:', error)
      return response.json({ success: false, error: 'Failed to update the attempt' }, 500)
    }
  },
})

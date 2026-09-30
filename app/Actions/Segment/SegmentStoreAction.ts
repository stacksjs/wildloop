// POST /api/segments — draw a segment out of one of your own activities.
//
// A segment cut from a real track is automatically a line somebody can follow,
// which is why this is the creation path rather than drawing on a map. The
// geometry, distance, ascent and bounding box are all derived from the slice
// here, so a caller cannot save a row whose numbers disagree with its own line.
//
// Only from your own activity, and only from one that was recorded: a segment
// is a claim about ground, and the track it is cut from has to be one somebody
// actually covered.

import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import Activity from '../../Models/Activity'
import { parseTrackSamples } from '../../../resources/functions/activity-integrity'
import { boundedString, positiveInt } from '../../../resources/functions/validate'
import { segmentDraft } from '../../../resources/functions/segment-draft'
import { recordSegmentEfforts } from '../../Support/segmentEfforts'

const REFUSALS: Record<string, string> = {
  'no-name': 'Give the segment a name.',
  'backwards': 'The finish has to come after the start.',
  'too-few-points': 'That stretch has too few GPS points to be a segment.',
  'too-short': 'A segment has to be at least a tenth of a mile.',
}

export default new Action({
  name: 'Segment Store',
  description: 'Create a segment from part of one of your activities',
  method: 'POST',

  async handle(request: any) {
    const user = await Auth.user().catch(() => null)
    if (!user?.id)
      return response.json({ success: false, error: 'Sign in to create a segment.' }, 401)
    const userId = Number(user.id)

    const activityId = positiveInt(request.get('activityId'))
    const name = boundedString(request.get('name'), 80)
    const startIndex = Number(request.get('startIndex'))
    const endIndex = Number(request.get('endIndex'))

    if (activityId === null)
      return response.json({ success: false, error: 'Which activity?' }, 422)
    if (name === null)
      return response.json({ success: false, error: REFUSALS['no-name'] }, 422)

    const activity = await Activity.find(activityId).catch(() => null)
    /*
     * A stranger gets the same answer as somebody asking about an activity
     * that does not exist. Saying "not yours" confirms it is somebody's, which
     * is a thing worth not confirming about a private run.
     */
    if (!activity || Number(activity.user_id) !== userId)
      return response.json({ success: false, error: 'Activity not found' }, 404)

    if (!activity.gpx_data)
      return response.json({ success: false, error: 'That activity has no recorded route to cut a segment from.' }, 422)

    const samples = parseTrackSamples(activity.gpx_data)
    const draft = segmentDraft(
      samples.map(sample => ({ lat: sample.lat, lng: sample.lng, eleFt: sample.altitude === null ? null : sample.altitude * 3.28084 })),
      startIndex,
      endIndex,
      name,
    )

    if (!draft.ok)
      return response.json({ success: false, error: REFUSALS[draft.reason] ?? 'That stretch cannot be a segment.' }, 422)

    try {
      const now = new Date().toISOString()
      const created = (await db.sql`
        INSERT INTO segments (
          uuid, trail_id, created_by, name, activity_type, geometry, distance, elevation,
          start_lat, start_lng, end_lat, end_lng, min_lat, max_lat, min_lng, max_lng,
          created_at, updated_at
        ) VALUES (
          ${crypto.randomUUID()}, ${activity.trail_id ?? null}, ${userId}, ${draft.draft.name},
          ${activity.activity_type}, ${JSON.stringify(draft.draft.geometry)},
          ${draft.draft.distance}, ${draft.draft.elevation},
          ${draft.draft.startLat}, ${draft.draft.startLng}, ${draft.draft.endLat}, ${draft.draft.endLng},
          ${draft.draft.minLat}, ${draft.draft.maxLat}, ${draft.draft.minLng}, ${draft.draft.maxLng},
          ${now}, ${now}
        )
        RETURNING id
      `.execute() as any[])[0]

      const segmentId = Number(created?.id ?? 0)
      if (!segmentId)
        return response.json({ success: false, error: 'Failed to create segment' }, 500)

      /*
       * Match the activity it was cut from straight away, so the person who
       * drew it is on their own board rather than looking at an empty one and
       * wondering whether it worked. Every other activity that ran this ground
       * is matched when it is next saved, or by a backfill — walking the whole
       * catalog here would make drawing a segment an expensive request.
       */
      await recordSegmentEfforts({
        id: activityId,
        userId,
        activityType: String(activity.activity_type),
        samples: samples.map(sample => ({ lat: sample.lat, lng: sample.lng, time: sample.time })),
      })

      return response.json({
        success: true,
        segment: {
          id: segmentId,
          name: draft.draft.name,
          distance: draft.draft.distance,
          elevation: draft.draft.elevation,
          trailId: activity.trail_id ?? null,
        },
      }, 201)
    }
    catch (error) {
      console.error('[segments] create failed:', error)
      return response.json({ success: false, error: 'Failed to create segment' }, 500)
    }
  },
})

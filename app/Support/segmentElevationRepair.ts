import { db } from '@stacksjs/orm'
import { parseTrackSamples } from '../../resources/functions/activity-integrity'
import { segmentDraft } from '../../resources/functions/segment-draft'

/**
 * When the recorder stopped uploading GPS altitude in feet.
 *
 * Until then it sent feet in a field every server reader takes as metres
 * (e3f98656). Migration 0000000183 converts the stored runs from before this
 * moment, and this repair recomputes the segments cut from them. Both use
 * this one instant; it is when that fix went live in production.
 */
export const FEET_ALTITUDE_UNTIL = '2026-10-04T05:24:27Z'

const METRES_TO_FEET = 3.28084

/** A segment endpoint is a fix of its source run, rounded to six places. */
const SAME_POINT = 1.5e-6

export interface SegmentElevationFix {
  id: number
  elevation: number
}

/**
 * Segments drawn from a run recorded before the fix, with the climb they
 * should show.
 *
 * A segment keeps its line but not which run it was cut from, so the run is
 * found again: the creator's own live-GPS runs from before the segment, whose
 * fixes include both of its endpoints in order. Its climb is then recomputed
 * the way it was drawn, from altitudes that are now metres. A segment whose
 * run cannot be found is left alone rather than guessed at.
 *
 * Idempotent: once the runs hold metres, the recomputed climb is the stored
 * one and nothing changes.
 */
export async function segmentElevationFixes(): Promise<SegmentElevationFix[]> {
  const segments = await db.sql`
    SELECT id, created_by, name, start_lat, start_lng, end_lat, end_lng, elevation, created_at
    FROM segments
    WHERE created_at < ${FEET_ALTITUDE_UNTIL} AND created_by IS NOT NULL
  `.execute().catch(() => []) as any[]

  const fixes: SegmentElevationFix[] = []
  for (const segment of segments ?? []) {
    const runs = await db.sql`
      SELECT gpx_data FROM activities
      WHERE user_id = ${segment.created_by}
        AND recording_source IN ('web_gps', 'native_gps')
        AND gpx_data IS NOT NULL
        AND created_at <= ${segment.created_at}
      ORDER BY created_at DESC
      LIMIT 50
    `.execute().catch(() => []) as Array<{ gpx_data: string }>

    for (const run of runs ?? []) {
      const samples = parseTrackSamples(run.gpx_data)
      const at = (lat: number, lng: number, from = 0): number => samples.findIndex((sample, index) =>
        index >= from && Math.abs(sample.lat - lat) <= SAME_POINT && Math.abs(sample.lng - lng) <= SAME_POINT)

      const start = at(Number(segment.start_lat), Number(segment.start_lng))
      if (start < 0)
        continue
      const end = at(Number(segment.end_lat), Number(segment.end_lng), start + 1)
      if (end < 0)
        continue

      const draft = segmentDraft(
        samples.map(sample => ({ lat: sample.lat, lng: sample.lng, eleFt: sample.altitude === null ? null : sample.altitude * METRES_TO_FEET })),
        start,
        end,
        String(segment.name ?? 'Segment'),
      )
      if (draft.ok && draft.draft.elevation !== Number(segment.elevation))
        fixes.push({ id: Number(segment.id), elevation: draft.draft.elevation })
      break
    }
  }
  return fixes
}

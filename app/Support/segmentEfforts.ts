/**
 * Working out which segments a saved activity ran.
 *
 * The deciding is in `resources/functions/segment-matching.ts`, which is pure
 * and has the tests. This is the part that needs a database: finding which
 * segments are worth testing at all, and writing down what was found.
 *
 * Candidates come from a bounding-box overlap rather than from the trail the
 * athlete said they were on. Somebody running a segment does not necessarily
 * pick the trail it belongs to when they start, and a segment near the end of
 * a long run is often on a different trail entirely.
 */

import type { TrackPoint } from '../../resources/functions/segment-matching'
import { db } from '@stacksjs/orm'
import { log } from '@stacksjs/logging'
import { matchSegment } from '../../resources/functions/segment-matching'

/** How far outside the activity's own box a segment may start and still be tried. */
const CANDIDATE_PAD_DEGREES = 0.01 // about a kilometre

interface SegmentRow {
  id: number
  geometry: string
  activity_type: string
}

/**
 * Match one activity against every segment it could plausibly have run, and
 * record the efforts.
 *
 * Returns how many efforts were matched, which is not always how many rows
 * were written: re-running the matcher over an activity matches the same
 * efforts again and the unique index quietly ignores them. Never throws: a
 * failure here loses a
 * place on a leaderboard, and throwing would lose the run itself. That is the
 * opposite of the call made for the Google identity row, and for a reason —
 * a missing identity silently changes who somebody is next time, while a
 * missing effort is recoverable by running the matcher over the activity
 * again. It is logged loudly so that recovery is possible at all.
 */
export async function recordSegmentEfforts(activity: {
  id: number
  userId: number
  activityType: string
  samples: TrackPoint[]
  /** Count what would be recorded without writing it. For a dry backfill. */
  dryRun?: boolean
  /** Only this segment, for backfilling one that was just drawn. */
  onlySegmentId?: number
}): Promise<number> {
  try {
    const usable = activity.samples.filter(s => Number.isFinite(s.lat) && Number.isFinite(s.lng))
    if (usable.length < 2)
      return 0

    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
    for (const point of usable) {
      if (point.lat < minLat) minLat = point.lat
      if (point.lat > maxLat) maxLat = point.lat
      if (point.lng < minLng) minLng = point.lng
      if (point.lng > maxLng) maxLng = point.lng
    }

    /*
     * Boxes overlap when neither is wholly past the other. Written as two
     * range predicates so the `segments_bbox_index` can serve it — a segment
     * whose box starts after ours ends, or ends before ours starts, cannot
     * touch it.
     */
    const candidates = await db.sql`
      SELECT id, geometry, activity_type
      FROM segments
      WHERE activity_type = ${activity.activityType}
        AND (${activity.onlySegmentId ?? null} IS NULL OR id = ${activity.onlySegmentId ?? null})
        AND min_lat <= ${maxLat + CANDIDATE_PAD_DEGREES}
        AND max_lat >= ${minLat - CANDIDATE_PAD_DEGREES}
        AND min_lng <= ${maxLng + CANDIDATE_PAD_DEGREES}
        AND max_lng >= ${minLng - CANDIDATE_PAD_DEGREES}
    `.execute() as SegmentRow[]

    if (!candidates?.length)
      return 0

    let matched = 0
    for (const segment of candidates) {
      const line = readGeometry(segment.geometry)
      if (!line)
        continue

      for (const effort of matchSegment(usable, line)) {
        matched += 1
        if (activity.dryRun)
          continue
        /*
         * `INSERT OR IGNORE` against the unique index on
         * (segment, activity, started_at). Re-running the matcher over an
         * activity — after a re-save, or to backfill a newly drawn segment —
         * must not double anybody's place on the board.
         */
        await db.sql`
          INSERT OR IGNORE INTO segment_efforts
            (segment_id, activity_id, user_id, elapsed_seconds, started_at, created_at)
          VALUES (
            ${segment.id}, ${activity.id}, ${activity.userId},
            ${effort.elapsedSeconds}, ${new Date(effort.startedAt).toISOString()}, ${new Date().toISOString()}
          )
        `.execute()
      }
    }

    if (matched > 0 && !activity.dryRun) {
      // Recounted rather than incremented, so a count cannot drift away from
      // the rows it describes after a deleted activity takes its efforts with it.
      await db.sql`
        UPDATE segments
        SET effort_count = (SELECT COUNT(*) FROM segment_efforts WHERE segment_id = segments.id)
        WHERE id IN (SELECT segment_id FROM segment_efforts WHERE activity_id = ${activity.id})
      `.execute()
    }

    return matched
  }
  catch (error) {
    log.error('[segments] could not match an activity against segments', { activityId: activity.id, error })
    return 0
  }
}

/**
 * The stored line as points.
 *
 * Accepts the two shapes the app writes: a flat list of pairs, and a list of
 * segments for a route assembled from parts.
 */
function readGeometry(raw: string): Array<{ lat: number, lng: number }> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    return null

  const flat = Array.isArray(parsed[0]) && Array.isArray((parsed as any[])[0][0])
    ? (parsed as any[][]).flat()
    : parsed as any[]

  const points = flat
    .map((point: any) => (Array.isArray(point)
      ? { lat: Number(point[0]), lng: Number(point[1]) }
      : { lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter(point => Number.isFinite(point.lat) && Number.isFinite(point.lng))

  return points.length >= 2 ? points : null
}

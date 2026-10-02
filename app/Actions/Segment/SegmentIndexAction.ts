// GET /api/trails/{id}/segments — the segments on a trail, with leaderboards.
//
// One row per athlete on each board, not one per effort: somebody who runs a
// climb every morning should appear once, at their best, rather than filling
// the top ten with their own week. That is the whole difference between a
// leaderboard and a log, and it is a window function rather than a GROUP BY
// because the board needs the effort's own date and activity alongside the
// time.

import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { positiveInt } from '../../../resources/functions/validate'

/** How many places each board shows. */
const BOARD_SIZE = 10

export default new Action({
  name: 'Segment Index',
  description: 'Segments on a trail, with their leaderboards',
  method: 'GET',

  async handle(request: any) {
    const trailId = positiveInt(request.get('id'))
    if (trailId === null)
      return response.json({ success: false, error: 'Unknown trail' }, 404)

    const viewer = await Auth.user().catch(() => null)
    const viewerId = viewer?.id ? Number(viewer.id) : null

    try {
      const segments = await db.sql`
        SELECT id, uuid, name, activity_type, distance, elevation, effort_count
        FROM segments
        WHERE trail_id = ${trailId}
        ORDER BY distance DESC, id ASC
      `.execute() as any[]

      if (!segments?.length)
        return response.json({ success: true, segments: [] })

      // Coerced and filtered before they reach the statement below, which
      // interpolates them: `IN` cannot take a bound array here, so the only
      // thing making this safe is that nothing but a positive integer survives.
      const ids = segments.map((s: any) => Number(s.id)).filter((id: number) => Number.isInteger(id) && id > 0)
      if (!ids.length)
        return response.json({ success: true, segments: [] })

      /*
       * Every athlete's best effort on these segments, ranked.
       *
       * `ROW_NUMBER` partitioned by (segment, athlete) picks each athlete's
       * quickest run; the outer one then orders those bests within the
       * segment. Done in one statement so a trail with a dozen segments is one
       * query rather than a dozen.
       *
       * A subquery rather than a WITH clause: the query builder hands back an
       * empty object for a statement that does not begin with SELECT, so a CTE
       * here reads as no rows rather than as an error.
       *
       * Ties break on the earlier effort: if two people run it in the same
       * time, the one who did it first holds the place.
       */
      const rows = await db.sql`
        SELECT
          pb.segment_id, pb.user_id, pb.elapsed_seconds, pb.started_at, pb.activity_id,
          u.name AS user_name,
          ROW_NUMBER() OVER (
            PARTITION BY pb.segment_id
            ORDER BY pb.elapsed_seconds ASC, pb.started_at ASC
          ) AS board_rank
        FROM (
          SELECT
            e.segment_id, e.user_id, e.elapsed_seconds, e.started_at, e.activity_id,
            ROW_NUMBER() OVER (
              PARTITION BY e.segment_id, e.user_id
              ORDER BY e.elapsed_seconds ASC, e.started_at ASC
            ) AS personal_rank
          FROM segment_efforts e
          WHERE e.segment_id IN (${db.unsafe(ids.join(','))})
        ) pb
        JOIN users u ON u.id = pb.user_id
        WHERE pb.personal_rank = 1
      `.execute() as any[]

      const boards = new Map<number, any[]>()
      for (const row of rows ?? []) {
        const list = boards.get(Number(row.segment_id)) ?? []
        list.push(row)
        boards.set(Number(row.segment_id), list)
      }

      return response.json({
        success: true,
        segments: segments.map((segment: any) => {
          const board = (boards.get(Number(segment.id)) ?? []).sort((a, b) => Number(a.board_rank) - Number(b.board_rank))
          const mine = viewerId === null ? null : board.find(row => Number(row.user_id) === viewerId) ?? null

          return {
            id: Number(segment.id),
            uuid: segment.uuid,
            name: segment.name,
            activityType: segment.activity_type,
            distance: Number(segment.distance),
            elevation: Number(segment.elevation ?? 0),
            totalAttempts: Number(segment.effort_count ?? 0),
            leader: board[0]
              ? { name: board[0].user_name, time: clock(Number(board[0].elapsed_seconds)), userId: Number(board[0].user_id) }
              : null,
            // The viewer's own place, however far down it is — a board that
            // only shows the top ten tells most people nothing about
            // themselves, which is the half they came to see.
            you: mine
              ? { time: clock(Number(mine.elapsed_seconds)), rank: Number(mine.board_rank), activityId: Number(mine.activity_id) }
              : null,
            board: board.slice(0, BOARD_SIZE).map((row: any) => ({
              rank: Number(row.board_rank),
              userId: Number(row.user_id),
              name: row.user_name,
              time: clock(Number(row.elapsed_seconds)),
              at: row.started_at,
            })),
          }
        }),
      })
    }
    catch (error) {
      console.error('[segments] index failed:', error)
      return response.json({ success: false, error: 'Failed to fetch segments' }, 500)
    }
  },
})

/** Seconds as a clock, dropping the hour when there is not one. */
function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0)
    return '—'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = Math.round(seconds % 60)
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
    : `${minutes}:${String(rest).padStart(2, '0')}`
}

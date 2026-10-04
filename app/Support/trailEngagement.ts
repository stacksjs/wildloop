import type { TrailActivity } from './trailRanking'
import { db } from '@stacksjs/orm'

/**
 * What Wildloop's own athletes have done with each of a set of trails.
 *
 * This is the popularity signal a trail app is built on: who saved a trail,
 * who walked it, who photographed it. Today it is thin, and ranking leans on
 * what the catalog row gives away instead; as people use the app it takes
 * over by itself, with no change to the ranking.
 *
 * Distinct people, not rows: one athlete running the same loop every morning
 * is one person who likes it, not three hundred.
 *
 * Three grouped reads for a page's worth of candidates. Each is narrowed by
 * an index on `trail_id` (migration 0000000182), so the cost follows the
 * number of candidates rather than the size of the activity log.
 */
export async function trailEngagement(trailIds: number[]): Promise<Map<number, TrailActivity>> {
  const result = new Map<number, TrailActivity>()

  // Coerced and filtered before they reach `db.unsafe`, which is the only
  // thing making it safe: nothing but a positive integer survives. `db.sql`
  // would bind the joined list as ONE string and match nothing (0271ea7f).
  const ids = [...new Set(trailIds.map(Number).filter(id => Number.isInteger(id) && id > 0))]
  if (ids.length === 0)
    return result

  const list = db.unsafe(ids.join(','))

  const entry = (id: number): TrailActivity => {
    let value = result.get(id)
    if (!value) {
      value = { saves: 0, completions: 0, photos: 0 }
      result.set(id, value)
    }
    return value
  }

  // A failed read costs that signal for one request and nothing else: the
  // list still ranks on everything else it knows.
  const [saves, completions, photos] = await Promise.all([
    db.sql`
      SELECT trail_id, COUNT(DISTINCT user_id) AS n
      FROM saved_trails
      WHERE trail_id IN (${list}) AND (is_saved = 1 OR has_visited = 1)
      GROUP BY trail_id
    `.execute().catch(() => []),
    db.sql`
      SELECT trail_id, COUNT(DISTINCT user_id) AS n
      FROM activities
      WHERE trail_id IN (${list})
      GROUP BY trail_id
    `.execute().catch(() => []),
    db.sql`
      SELECT trail_id, COUNT(DISTINCT user_id) AS n
      FROM trail_photos
      WHERE trail_id IN (${list}) AND status = 'visible'
      GROUP BY trail_id
    `.execute().catch(() => []),
  ]) as Array<Array<{ trail_id: number, n: number }>>

  for (const row of saves ?? [])
    entry(Number(row.trail_id)).saves = Number(row.n) || 0
  for (const row of completions ?? [])
    entry(Number(row.trail_id)).completions = Number(row.n) || 0
  for (const row of photos ?? [])
    entry(Number(row.trail_id)).photos = Number(row.n) || 0

  return result
}

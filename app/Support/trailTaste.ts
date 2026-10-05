import type { TasteProfile } from './trailRanking'
import { db } from '@stacksjs/orm'
import { tasteProfile } from './trailRanking'

export interface AthleteTaste {
  profile: TasteProfile | null
  /**
   * Trails they already know: saved, marked done, or recorded on. Left out of
   * "you may like", which is for finding the next one.
   */
  known: Set<number>
}

const NO_TASTE: AthleteTaste = { profile: null, known: new Set() }

/**
 * The most recent trails a taste is read from. Enough to be a taste, few
 * enough that somebody who has changed what they do is not judged on what
 * they did three years ago.
 */
const TASTE_WINDOW = 60

/**
 * What kind of trail an athlete likes, from what they saved and what they did.
 *
 * Saves count as much as completions: a heart is somebody saying "this is the
 * kind of trail I want", which is the question being answered. A failed read
 * answers "no taste", so the list falls back to best match rather than
 * failing.
 *
 * Read on the whole trail, pieces included (`trail_totals`,
 * app/Support/wholeTrail.ts), as the candidates it is matched against are.
 */
export async function athleteTaste(userId: number | null | undefined): Promise<AthleteTaste> {
  const id = Number(userId)
  if (!Number.isInteger(id) || id <= 0)
    return NO_TASTE

  try {
    const rows = await db.sql`
      SELECT t.id, COALESCE(w.distance, t.distance) AS distance, COALESCE(w.difficulty, t.difficulty) AS difficulty, t.route_type
      FROM trails t
      LEFT JOIN trail_totals w ON w.trail_id = t.id
      JOIN (
        SELECT trail_id, MAX(at) AS at FROM (
          SELECT trail_id, COALESCE(updated_at, created_at) AS at
          FROM saved_trails
          WHERE user_id = ${id} AND (is_saved = 1 OR has_visited = 1)
          UNION ALL
          SELECT trail_id, COALESCE(completed_at, created_at) AS at
          FROM activities
          WHERE user_id = ${id} AND trail_id IS NOT NULL
        )
        GROUP BY trail_id
      ) mine ON mine.trail_id = t.id
      ORDER BY mine.at DESC
    `.execute() as Array<{ id: number, distance: number, difficulty: string, route_type: string | null }>

    return {
      profile: tasteProfile((rows ?? []).slice(0, TASTE_WINDOW)),
      known: new Set((rows ?? []).map(row => Number(row.id))),
    }
  }
  catch (error) {
    console.warn(`[trails] taste read failed: ${error instanceof Error ? error.message : error}`)
    return NO_TASTE
  }
}

/**
 * Which trails someone has done, from what they recorded.
 *
 * A trail counts as completed when one of their activities is on it
 * (`activities.trail_id`), or when they marked a saved trail as visited
 * (`saved_trails.has_visited`) — the way to say "done it" about a trail
 * walked before Wildloop, or recorded without picking the trail.
 */

export interface CompletionActivity {
  trail_id: number | null
  completed_at?: string | null
  created_at?: string | null
}

export interface Completion {
  trailId: number
  /** Activities on this trail. 0 when it is only marked visited. */
  times: number
  /** The most recent of those activities, else when it was marked. */
  lastCompletedAt: string | null
}

export function summariseCompletions(
  activities: CompletionActivity[],
  visited: { trail_id: number, updated_at?: string | null, created_at?: string | null }[] = [],
): Completion[] {
  const byTrail = new Map<number, Completion>()

  for (const activity of activities) {
    const trailId = Number(activity.trail_id)
    if (!Number.isInteger(trailId) || trailId <= 0)
      continue
    const at = activity.completed_at || activity.created_at || null
    const entry = byTrail.get(trailId) ?? { trailId, times: 0, lastCompletedAt: null }
    entry.times++
    if (at && (!entry.lastCompletedAt || at > entry.lastCompletedAt))
      entry.lastCompletedAt = at
    byTrail.set(trailId, entry)
  }

  for (const save of visited) {
    const trailId = Number(save.trail_id)
    if (!Number.isInteger(trailId) || trailId <= 0 || byTrail.has(trailId))
      continue
    byTrail.set(trailId, { trailId, times: 0, lastCompletedAt: save.updated_at || save.created_at || null })
  }

  // Most recent first; undated ones last, then by id so the order is stable.
  return [...byTrail.values()].sort((a, b) => {
    if (a.lastCompletedAt && b.lastCompletedAt && a.lastCompletedAt !== b.lastCompletedAt)
      return a.lastCompletedAt < b.lastCompletedAt ? 1 : -1
    if (!a.lastCompletedAt !== !b.lastCompletedAt)
      return a.lastCompletedAt ? -1 : 1
    return a.trailId - b.trailId
  })
}

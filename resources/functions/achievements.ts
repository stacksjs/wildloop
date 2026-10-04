/**
 * Pure achievement math (#982). The engine action computes per-user metric
 * values from rows; these helpers handle the two non-trivial ones (streaks,
 * fast splits) and the generic progress merge.
 */

/** Longest run of consecutive calendar days (UTC) with at least one date. */
export function longestDayStreak(dates: Array<string | null | undefined>): number {
  const days = new Set<string>()
  for (const d of dates) {
    if (!d)
      continue
    const t = new Date(d.includes('T') || d.includes(' ') ? d : `${d}T00:00:00Z`)
    if (Number.isNaN(t.getTime()))
      continue
    days.add(t.toISOString().slice(0, 10))
  }
  if (!days.size)
    return 0
  const sorted = [...days].sort()
  let best = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    const prev = Date.parse(`${sorted[i - 1]}T00:00:00Z`)
    const cur = Date.parse(`${sorted[i]}T00:00:00Z`)
    run = cur - prev === 86_400_000 ? run + 1 : 1
    if (run > best)
      best = run
  }
  return best
}

/** Parse a `MM:SS` pace label (with optional `/mi` suffix) to seconds. */
function paceToSeconds(pace: unknown): number | null {
  if (typeof pace !== 'string')
    return null
  const m = pace.match(/^(\d+):([0-5]\d)/)
  if (!m)
    return null
  return Number(m[1]) * 60 + Number(m[2])
}

/** True if any split across all activities is faster than 7:00/mi. */
export function hasSubSevenMile(splitsJsonList: Array<string | null | undefined>, thresholdS = 420): boolean {
  for (const raw of splitsJsonList) {
    if (!raw)
      continue
    let splits: unknown
    try {
      splits = JSON.parse(raw)
    }
    catch {
      continue
    }
    if (!Array.isArray(splits))
      continue
    for (const s of splits) {
      const secs = paceToSeconds((s as any)?.pace)
      if (secs !== null && secs < thresholdS)
        return true
    }
  }
  return false
}

export interface AchievementDefinitionRow {
  id: number
  metric?: string | null
  target_value?: number | null
}

export interface AchievementProgressEntry {
  achievement_id: number
  progress: number
  is_complete: boolean
}

/** Merge metric values against definitions into progress entries. */
export function computeAchievementProgress(
  definitions: AchievementDefinitionRow[],
  metricValues: Record<string, number>,
): AchievementProgressEntry[] {
  const entries: AchievementProgressEntry[] = []
  for (const def of definitions) {
    if (!def.metric || !(def.metric in metricValues))
      continue
    const target = def.target_value ?? 1
    const value = metricValues[def.metric] ?? 0
    entries.push({
      achievement_id: def.id,
      progress: Math.round(value * 10) / 10,
      is_complete: value >= target,
    })
  }
  return entries
}

export interface AchievementMetricActivity {
  distance?: number | null
  elevation?: number | null
  trail_id?: number | null
  completed_at?: string | null
  splits?: string | null
  integrity_status?: string | null
}

export interface AchievementMetricStats {
  territories_conquered?: number | null
  territories_defended?: number | null
  total_territories_owned?: number | null
}

/**
 * Every metric an achievement can be defined against, folded from the rows
 * that are its source of truth.
 *
 * Pure so the unlock engine and the seeder compute a user's standing the same
 * way. The metric names are the model's `metrics` enum, and a definition
 * naming one that is missing here is skipped by `computeAchievementProgress`
 * rather than silently reading zero.
 */
export function achievementMetricValues(input: {
  activities: AchievementMetricActivity[]
  kudosGiven: unknown[]
  stats?: AchievementMetricStats | null
}): Record<string, number> {
  const { kudosGiven, stats } = input
  // A track the integrity checks refused is in the athlete's log, but a car
  // ride home is not a hundred-mile month or a sub-seven mile, so it earns
  // nothing here.
  const activities = input.activities.filter(activity => activity.integrity_status !== 'rejected')
  return {
    activities: activities.length,
    distinct_trails: new Set(activities.map(a => a.trail_id).filter(Boolean)).size,
    total_miles: activities.reduce((sum, a) => sum + (a.distance ?? 0), 0),
    total_elevation: activities.reduce((sum, a) => sum + (a.elevation ?? 0), 0),
    territories_conquered: stats?.territories_conquered ?? 0,
    territories_defended: stats?.territories_defended ?? 0,
    territories_owned: stats?.total_territories_owned ?? 0,
    kudos_given: kudosGiven.length,
    streak_days: longestDayStreak(activities.map(a => a.completed_at)),
    fast_mile: hasSubSevenMile(activities.map(a => a.splits)) ? 1 : 0,
  }
}

/**
 * Training totals folded from an athlete's own activities.
 *
 * The `/stats` and `/profile` summaries used to read a fixture baked into the
 * client store, so every account — including one with no activities at all —
 * reported the same 78.4 miles, 8 trails and a 12-day streak. There is no
 * endpoint that returns these numbers: `user_stats` carries lifetime totals
 * but no weekly or monthly split, and the athlete endpoint carries neither.
 *
 * They are all derivable from the activities the store has already hydrated,
 * which is also what makes them trustworthy — the number above the feed is a
 * fold over the same rows the feed is showing, so the two cannot disagree.
 *
 * Pure, and unit-testable without a store or a browser.
 */

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

export interface TrainingActivity {
  user_id?: number | null
  distance?: number | null
  elevation_gain?: number | null
  trail_id?: number | null
  duration?: string | null
  moving_time?: string | null
  splits?: Array<{ pace?: string | null }> | null
  created_at?: string | null
}

export interface TrainingStats {
  user_id: number
  totalDistance: number
  totalElevation: number
  trailsCompleted: number
  totalActivities: number
  currentStreak: number
  longestStreak: number
  totalTime: string
  avgPace: string
  totalCalories: number
  weeklyDistance: number
  weeklyElevation: number
  weeklyActivities: number
  monthlyDistance: number
  monthlyElevation: number
  personalRecords: {
    fastestMile: string
    longestRun: number
    biggestClimb: number
    longestStreak: number
  }
  weeklyHistory: Array<{ week: string, distance: number, elevation: number }>
}

/** `h:mm:ss` or `mm:ss` to seconds. Anything unparseable counts as nothing. */
export function durationSeconds(value: string | null | undefined): number {
  if (typeof value !== 'string')
    return 0
  const parts = value.split(':').map(Number)
  if (parts.some(Number.isNaN))
    return 0
  if (parts.length === 3)
    return parts[0] * 3600 + parts[1] * 60 + parts[2]
  if (parts.length === 2)
    return parts[0] * 60 + parts[1]
  return 0
}

/** `MM:SS` pace label to seconds per mile. */
function paceSeconds(value: string | null | undefined): number | null {
  if (typeof value !== 'string')
    return null
  const match = value.match(/^(\d+):([0-5]\d)/)
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}

function paceLabel(secondsPerMile: number): string {
  const m = Math.floor(secondsPerMile / 60)
  const s = Math.round(secondsPerMile % 60)
  return `${m}:${String(s).padStart(2, '0')}/mi`
}

function round(value: number, places = 1): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

/** Calendar days (UTC) an activity was recorded on. */
function activeDays(activities: TrainingActivity[]): string[] {
  const days = new Set<string>()
  for (const activity of activities) {
    if (!activity.created_at)
      continue
    const time = new Date(activity.created_at)
    if (!Number.isNaN(time.getTime()))
      days.add(time.toISOString().slice(0, 10))
  }
  return [...days].sort()
}

/** The run of consecutive days ending today or yesterday. */
function currentStreak(days: string[], now: number): number {
  if (!days.length)
    return 0
  const today = new Date(now).toISOString().slice(0, 10)
  const set = new Set(days)
  // A streak survives until the day after the last activity is over, so it is
  // measured from yesterday when nothing has been logged today yet.
  let cursor = set.has(today) ? now : now - DAY_MS
  let streak = 0
  while (set.has(new Date(cursor).toISOString().slice(0, 10))) {
    streak++
    cursor -= DAY_MS
  }
  return streak
}

/** The longest run of consecutive days ever. */
function longestStreak(days: string[]): number {
  let best = 0
  let run = 0
  let previous = Number.NaN
  for (const day of days) {
    const time = Date.parse(`${day}T00:00:00Z`)
    run = time - previous === DAY_MS ? run + 1 : 1
    previous = time
    if (run > best)
      best = run
  }
  return best
}

export function computeTrainingStats(
  userId: number,
  allActivities: TrainingActivity[],
  opts: { now?: number, weeks?: number } = {},
): TrainingStats {
  const now = opts.now ?? Date.now()
  const weeks = opts.weeks ?? 6
  const mine = allActivities.filter(a => Number(a.user_id) === userId)

  const totalDistance = mine.reduce((sum, a) => sum + (a.distance ?? 0), 0)
  const totalElevation = mine.reduce((sum, a) => sum + (a.elevation_gain ?? 0), 0)
  const totalSeconds = mine.reduce((sum, a) => sum + durationSeconds(a.moving_time ?? a.duration), 0)

  const since = (ms: number) => mine.filter((a) => {
    const time = a.created_at ? new Date(a.created_at).getTime() : Number.NaN
    return Number.isFinite(time) && now - time <= ms
  })
  const thisWeek = since(WEEK_MS)
  const thisMonth = since(30 * DAY_MS)

  const days = activeDays(mine)

  // Splits are the only source of a mile-level pace. Without them the record
  // is honestly absent rather than a whole-run average dressed up as a mile.
  const splitPaces = mine
    .flatMap(a => a.splits ?? [])
    .map(split => paceSeconds(split?.pace))
    .filter((value): value is number => value !== null)

  const history: TrainingStats['weeklyHistory'] = []
  for (let index = weeks - 1; index >= 0; index--) {
    const end = now - index * WEEK_MS
    const start = end - WEEK_MS
    const inWeek = mine.filter((a) => {
      const time = a.created_at ? new Date(a.created_at).getTime() : Number.NaN
      return Number.isFinite(time) && time > start && time <= end
    })
    history.push({
      week: index === 0 ? 'This week' : index === 1 ? 'Last week' : `${index} weeks ago`,
      distance: round(inWeek.reduce((sum, a) => sum + (a.distance ?? 0), 0)),
      elevation: Math.round(inWeek.reduce((sum, a) => sum + (a.elevation_gain ?? 0), 0)),
    })
  }

  return {
    user_id: userId,
    totalDistance: round(totalDistance),
    totalElevation: Math.round(totalElevation),
    trailsCompleted: new Set(mine.map(a => a.trail_id).filter(Boolean)).size,
    totalActivities: mine.length,
    currentStreak: currentStreak(days, now),
    longestStreak: longestStreak(days),
    totalTime: `${Math.floor(totalSeconds / 3600)}h ${String(Math.round((totalSeconds % 3600) / 60)).padStart(2, '0')}m`,
    avgPace: totalDistance > 0 && totalSeconds > 0 ? paceLabel(totalSeconds / totalDistance) : '—',
    // Roughly 100 kcal a mile plus 50 per 100ft climbed. A ballpark, and
    // labelled as an estimate wherever it is shown.
    totalCalories: Math.round(totalDistance * 100 + totalElevation * 0.5),
    weeklyDistance: round(thisWeek.reduce((sum, a) => sum + (a.distance ?? 0), 0)),
    weeklyElevation: Math.round(thisWeek.reduce((sum, a) => sum + (a.elevation_gain ?? 0), 0)),
    weeklyActivities: thisWeek.length,
    monthlyDistance: round(thisMonth.reduce((sum, a) => sum + (a.distance ?? 0), 0)),
    monthlyElevation: Math.round(thisMonth.reduce((sum, a) => sum + (a.elevation_gain ?? 0), 0)),
    personalRecords: {
      fastestMile: splitPaces.length ? paceLabel(Math.min(...splitPaces)).replace('/mi', '') : '—',
      longestRun: round(Math.max(0, ...mine.map(a => a.distance ?? 0))),
      biggestClimb: Math.round(Math.max(0, ...mine.map(a => a.elevation_gain ?? 0))),
      longestStreak: longestStreak(days),
    },
    weeklyHistory: history,
  }
}

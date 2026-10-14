/**
 * Pure achievement math (#982). The engine action computes per-user metric
 * values from rows; these helpers handle the two non-trivial ones (streaks,
 * fast splits) and the generic progress merge.
 *
 * Below the engine's half: what a screen needs to *show* achievements, added
 * when `/achievements` was promoted to a native screen. The records and the
 * year were already shared through `personal-bests.ts`; these are the two
 * endpoints, the badge rows, and the geometry of the year chart, which a
 * native screen draws as an SVG rather than as twelve divs with a percentage
 * height.
 */

import type { MonthProgress } from './personal-bests'
import { barGeometry } from './bar-chart'
import { formatMiles } from './personal-bests'

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

export interface BadgeRow {
  id: number
  name: string
  description: string
  /** The emoji the catalog carries. Native draws it as text, as the web does. */
  icon: string
  progress: number
  total: number
}

/** The athlete's badges, earned and not. Their own id, so it needs their token. */
export function achievementsPath(userId: number): string {
  return `/api/users/${encodeURIComponent(String(userId))}/achievements`
}

/**
 * The rows the records and the year are computed from.
 *
 * 500 is what the web page asks for: enough to hold a full year for anybody
 * who is not running twice a day, and the records are only as true as the
 * window they are taken over.
 */
export function activitiesPath(userId: number, limit = 500): string {
  return `/api/activities?user_id=${encodeURIComponent(String(userId))}&limit=${encodeURIComponent(String(limit))}`
}

function text(value: unknown): string {
  return value == null ? '' : String(value)
}

function count(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function badgeRowsFrom(payload: unknown): BadgeRow[] {
  const source = payload as { achievements?: unknown } | unknown[] | null
  const list = Array.isArray(source)
    ? source
    : Array.isArray((source as { achievements?: unknown })?.achievements)
      ? (source as { achievements: unknown[] }).achievements
      : []

  const rows: BadgeRow[] = []
  for (const entry of list) {
    const badge = entry as Record<string, unknown>
    const id = Number(badge?.id)
    if (!Number.isFinite(id))
      continue

    rows.push({
      id,
      name: text(badge.name) || 'Badge',
      description: text(badge.description),
      icon: text(badge.icon),
      progress: count(badge.progress),
      // A badge with no target cannot be earned by progressing, so it is
      // treated as a single step rather than as a division by zero.
      total: Math.max(1, count(badge.total)),
    })
  }
  return rows
}

/** Earned when the progress has reached the target — never un-earned. */
export function badgeIsEarned(badge: Partial<BadgeRow> | null | undefined): boolean {
  return count(badge?.progress) >= Math.max(1, count(badge?.total))
}

/** `3/10`, with the progress clamped: an over-run badge is still 10/10. */
export function badgeProgressText(badge: Partial<BadgeRow> | null | undefined): string {
  const total = Math.max(1, count(badge?.total))
  return `${Math.min(count(badge?.progress), total)}/${total}`
}

/**
 * Earned badges first — what somebody opens this screen to see — and then the
 * unearned ones nearest to being earned.
 *
 * Earned badges keep the catalog's own order. Ranking them against each other
 * by progress says Empire Builder at 14/10 is more earned than First Loop at
 * 1/1, which is not a thing: a badge is earned or it is not, and how far past
 * the line somebody went is an artefact of the metric, not an achievement.
 */
export function sortBadges(rows: BadgeRow[]): BadgeRow[] {
  return [...rows].sort((a, b) => {
    const earned = Number(badgeIsEarned(b)) - Number(badgeIsEarned(a))
    if (earned !== 0)
      return earned
    if (badgeIsEarned(a))
      return 0
    return (b.progress / b.total) - (a.progress / a.total)
  })
}

export interface MonthBar {
  month: number
  label: string
  x: number
  y: number
  width: number
  height: number
}

/** The chart's box, in the units the screen's viewBox declares. */
export const YEAR_CHART = { width: 312, height: 72, gap: 4 } as const

/** Twelve bars across the box, each as tall as its share of the best month. */
export function monthBars(months: MonthProgress[], box = YEAR_CHART): MonthBar[] {
  const bars = barGeometry(months.map(month => month.miles), box)
  return months.map((month, index) => ({ month: month.month, label: month.label, ...bars[index] }))
}

/** The year's total, as the caption under the chart. */
export function yearTotalText(months: MonthProgress[]): string {
  return `${formatMiles(months.reduce((sum, month) => sum + month.miles, 0))} this year`
}

/*
 * `monthlyProgress` labels a month with one letter, which is what a chart axis
 * wants and not what a sentence does — "M was the biggest" names nothing.
 */
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** The best month, named in full, or '' before there is one. */
export function bestMonthText(months: MonthProgress[]): string {
  const best = months.reduce<MonthProgress | null>((top, month) => (!top || month.miles > top.miles ? month : top), null)
  if (!best || best.miles <= 0)
    return ''
  return `${MONTH_NAMES[best.month] ?? best.label} was the biggest, at ${formatMiles(best.miles)}`
}

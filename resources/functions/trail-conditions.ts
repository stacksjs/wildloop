/**
 * Trail conditions: what people report when they review a trail, and how
 * worried the page should be about it.
 *
 * One list for the review form, the API's validation, the model and the
 * database's CHECK (migration 0000000166), so a condition cannot be offered
 * that the server refuses. Pure: this directory is auto-imported into the
 * server bundle too.
 */

export type ConditionSeverity = 'good' | 'caution' | 'danger'

export interface ConditionOption {
  id: string
  label: string
  severity: ConditionSeverity
  /** A lucide icon class. */
  icon: string
}

export const TRAIL_CONDITIONS: readonly ConditionOption[] = [
  { id: 'excellent', label: 'Excellent', severity: 'good', icon: 'i-lucide-sparkles' },
  { id: 'good', label: 'Good', severity: 'good', icon: 'i-lucide-thumbs-up' },
  { id: 'fair', label: 'Fair', severity: 'good', icon: 'i-lucide-cloud-sun' },
  { id: 'poor', label: 'Poor', severity: 'caution', icon: 'i-lucide-thumbs-down' },
  { id: 'muddy', label: 'Muddy', severity: 'caution', icon: 'i-lucide-droplets' },
  { id: 'fallen-trees', label: 'Fallen trees', severity: 'caution', icon: 'i-lucide-tree-pine' },
  { id: 'snowy', label: 'Snow', severity: 'danger', icon: 'i-lucide-snowflake' },
  { id: 'icy', label: 'Icy', severity: 'danger', icon: 'i-lucide-snowflake' },
  { id: 'flooded', label: 'Flooded', severity: 'danger', icon: 'i-lucide-waves' },
  { id: 'washed-out', label: 'Washed out', severity: 'danger', icon: 'i-lucide-construction' },
  { id: 'extreme-heat', label: 'Extreme heat', severity: 'danger', icon: 'i-lucide-thermometer-sun' },
  { id: 'wildfire', label: 'Wildfire or smoke', severity: 'danger', icon: 'i-lucide-flame' },
  { id: 'closed', label: 'Closed', severity: 'danger', icon: 'i-lucide-ban' },
]

export const TRAIL_CONDITION_IDS: readonly string[] = TRAIL_CONDITIONS.map(c => c.id)

export function conditionOption(id: string | null | undefined): ConditionOption | null {
  return TRAIL_CONDITIONS.find(c => c.id === id) ?? null
}

export interface ConditionReport extends ConditionOption {
  /** Who reported it. */
  by: string
  /** When the condition was seen. */
  at: string
  /** What they wrote alongside it. */
  note: string
}

interface ReviewLike {
  conditions?: string | null
  userName?: string | null
  /** When this condition was seen, decided at write time by the API. */
  conditionsReportedAt?: string | null
  conditions_reported_at?: string | null
  visitDate?: string | null
  visit_date?: string | null
  createdAt?: string | null
  created_at?: string | null
  text?: string | null
  content?: string | null
}

/**
 * Dangers a later "the trail is fine" report really does contradict.
 *
 * Someone who walks a trail and calls it good has seen the ground: the ice,
 * the snow and the water are either there or they are not. They have not seen
 * whether a closure was lifted, whether the fire is out, whether the washout
 * was repaired, or what tomorrow's heat will be — a path-quality report is no
 * evidence about any of those, so only time clears them.
 */
const CLEARED_BY_A_GOOD_REPORT: readonly string[] = ['snowy', 'icy', 'flooded']

const DAY_MS = 24 * 60 * 60 * 1000

function timeOf(value: string): number {
  const t = Date.parse(value)
  return Number.isNaN(t) ? 0 : t
}

/**
 * The condition reports among these reviews, newest first. Older than
 * `maxAgeDays` is history, not conditions, and is left out.
 */
export function conditionReports(reviews: ReviewLike[], now: number = Date.now(), maxAgeDays = 60): ConditionReport[] {
  const reports: ConditionReport[] = []
  for (const review of reviews) {
    const option = conditionOption(review.conditions)
    if (!option)
      continue
    // The report time the API settled, else the review's own dates for seed
    // rows and for reviews written before the column existed.
    const at = review.conditionsReportedAt || review.conditions_reported_at
      || review.visitDate || review.visit_date || review.createdAt || review.created_at || ''
    const t = timeOf(at)
    if (!t || now - t > maxAgeDays * DAY_MS)
      continue
    reports.push({ ...option, by: review.userName || 'Someone', at, note: String(review.text ?? review.content ?? '').trim() })
  }
  return reports.sort((a, b) => timeOf(b.at) - timeOf(a.at))
}

/**
 * The newest danger reported in the last `days` days that nobody has since
 * contradicted.
 *
 * Clearing one is deliberately narrow. A caution report (muddy, fallen trees)
 * never clears anything: mud is no answer to whether the ice has gone. A good
 * report clears only the ground conditions it actually speaks to, and a good
 * report older than the danger is not an answer to it at all. So a closure, a
 * wildfire, a washout or extreme heat stands until it ages out, rather than
 * being certified gone by a stranger who said the path was pleasant.
 */
export function activeDanger(reports: ConditionReport[], now: number = Date.now(), days = 7): ConditionReport | null {
  const recent = reports.filter(r => now - timeOf(r.at) <= days * DAY_MS)
  const good = recent.filter(r => r.severity === 'good')
  for (const report of recent) {
    if (report.severity !== 'danger')
      continue
    const cleared = CLEARED_BY_A_GOOD_REPORT.includes(report.id)
      && good.some(r => timeOf(r.at) > timeOf(report.at))
    if (!cleared)
      return report
  }
  return null
}

/**
 * What a leaderboard is, independent of how it is drawn.
 *
 * Three axes — the period, the measure, and whose board it is — one query
 * built from them, and one way of putting a row's figures into words. The web
 * page and the native screen choose differently between a pill row and a
 * cycling button; they must not choose differently about what "this week"
 * covers or how many feet somebody climbed.
 */

export const LEADERBOARD_PERIODS = ['weekly', 'monthly', 'alltime'] as const
export type LeaderboardPeriod = typeof LEADERBOARD_PERIODS[number]

export const LEADERBOARD_METRICS = ['distance', 'elevation', 'activities'] as const
export type LeaderboardMetric = typeof LEADERBOARD_METRICS[number]

export const LEADERBOARD_SCOPES = ['global', 'following', 'local'] as const
export type LeaderboardScope = typeof LEADERBOARD_SCOPES[number]

export interface LeaderRow {
  rank: number
  userId: number | null
  userName: string
  userAvatar: string | null
  totalDistance: number
  totalElevation: number
  trailsCompleted: number
}

/** "this week", for the sentence under the title. */
export function periodPhrase(period: LeaderboardPeriod): string {
  if (period === 'monthly')
    return 'this month'
  if (period === 'alltime')
    return 'of all time'
  return 'this week'
}

/** "covered the most ground", the other half of that sentence. */
export function metricPhrase(metric: LeaderboardMetric): string {
  if (metric === 'elevation')
    return 'climbed the most'
  if (metric === 'activities')
    return 'logged the most activities'
  return 'covered the most ground'
}

/**
 * The query the board is read with.
 *
 * `local` carries a coordinate rounded to two places — about a kilometre,
 * enough to find the right city and not enough to find a house. A `local`
 * board with no fix asks for the global one instead rather than sending a
 * filter the API cannot honour.
 *
 * Built by hand rather than with `URLSearchParams`, which this module cannot
 * use: the native runtime is JavaScriptCore with no web APIs, and a shared
 * module that reaches for one throws `URLSearchParams is not defined` on the
 * phone while passing every test in the browser. `encodeURIComponent` is in
 * the language rather than the platform, so it is there.
 */
export function leaderboardQuery(options: {
  period: LeaderboardPeriod
  metric: LeaderboardMetric
  scope: LeaderboardScope
  area?: { lat: number, lng: number } | null
}): string {
  const scope = options.scope === 'local' && !options.area ? 'global' : options.scope
  const pairs: [string, string][] = [
    ['period', options.period],
    ['metric', options.metric],
    ['scope', scope],
  ]

  if (scope === 'local' && options.area) {
    pairs.push(['lat', String(Math.round(options.area.lat * 100) / 100)])
    pairs.push(['lng', String(Math.round(options.area.lng * 100) / 100)])
  }

  return pairs.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
}

/**
 * The API's rows, with a rank even when the API did not send one.
 *
 * A row can carry `userId: null` — the board aggregates anonymous activity
 * under one "Athlete" — and that is not a row anybody can tap through to a
 * profile, so the id stays null rather than becoming 0.
 */
export function leaderRowsFrom(payload: unknown): LeaderRow[] {
  const list = (payload as { leaderboard?: unknown[] })?.leaderboard
  if (!Array.isArray(list))
    return []

  return list.map((entry, index) => {
    const row = entry as Record<string, unknown>
    const userId = Number(row.userId)
    return {
      rank: Number(row.rank) || index + 1,
      userId: Number.isInteger(userId) && userId > 0 ? userId : null,
      userName: String(row.userName || 'Athlete'),
      userAvatar: typeof row.userAvatar === 'string' && row.userAvatar ? row.userAvatar : null,
      totalDistance: Number(row.totalDistance) || 0,
      totalElevation: Number(row.totalElevation) || 0,
      trailsCompleted: Number(row.trailsCompleted) || 0,
    }
  })
}

/** The figure the board is ranked by, in the unit it is measured in. */
export function leaderMetricText(row: LeaderRow | undefined, metric: LeaderboardMetric): string {
  if (!row)
    return ''
  if (metric === 'elevation')
    return `${row.totalElevation.toLocaleString()} ft`
  if (metric === 'activities')
    return row.trailsCompleted === 1 ? '1 activity' : `${row.trailsCompleted} activities`
  return `${row.totalDistance.toFixed(1)} mi`
}

/** Whichever of distance and elevation the board is not ranked by. */
export function leaderSecondaryText(row: LeaderRow | undefined, metric: LeaderboardMetric): string {
  if (!row)
    return ''
  if (metric === 'distance')
    return `${row.totalElevation.toLocaleString()} ft`
  return `${row.totalDistance.toFixed(1)} mi`
}

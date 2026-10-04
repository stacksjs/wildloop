/**
 * Territory leaderboard ranking math (#944).
 *
 * Pure functions - no DB/model access - so the same logic serves the
 * ComputeTerritoryRanksAction (HTTP/on-demand), the `buddy territory:ranks`
 * command (cron), and tests.
 */

export interface TerritoryRankStatsRow {
  id: number
  /** Null on a row whose account is gone; such rows are not ranked. */
  user_id: number | null
  total_area_owned?: number | null
  total_territories_owned?: number | null
  weekly_rank?: number | null
  all_time_rank?: number | null
}

export interface TerritoryGainEvent {
  user_id: number
  event_type: string
  area_at_event?: number | null
  created_at?: string | null
}

export interface TerritoryRankAssignment {
  id: number
  user_id: number
  weekly_rank: number
  all_time_rank: number
}

/** Parse a DB timestamp; SQLite's CURRENT_TIMESTAMP ('YYYY-MM-DD HH:MM:SS') is UTC. */
function timestampMs(value: string | null | undefined): number {
  if (!value)
    return Number.NaN
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  return new Date(iso).getTime()
}

/**
 * Compute weekly + all-time leaderboard ranks for every stats row.
 *
 * - All-time ranks current empire size: `total_area_owned` desc, tiebreak
 *   territories owned desc, then user_id asc (deterministic).
 * - Weekly ranks area GAINED in the trailing window (claimed + conquered
 *   history events) - what you took this week, not your net worth. Users with
 *   no gains follow the gainers, ordered by their all-time standing.
 *
 * Ranks are ordinal (1..N) with deterministic tiebreaks.
 */
export function computeTerritoryRankAssignments(
  stats: TerritoryRankStatsRow[],
  gainEvents: TerritoryGainEvent[],
  opts: { windowDays?: number, now?: number } = {},
): TerritoryRankAssignment[] {
  const windowDays = opts.windowDays ?? 7
  const now = opts.now ?? Date.now()
  const since = now - windowDays * 86400000

  // A row whose player is gone holds no rank. Production has twenty of them,
  // and ranked among them the third-largest real holder came ninth.
  const players = stats.filter((s): s is TerritoryRankStatsRow & { user_id: number } => s.user_id != null)

  const allTimeOrder = [...players].sort((a, b) =>
    (b.total_area_owned ?? 0) - (a.total_area_owned ?? 0)
    || (b.total_territories_owned ?? 0) - (a.total_territories_owned ?? 0)
    || a.user_id - b.user_id)
  const allTimeRank = new Map(allTimeOrder.map((s, i) => [s.user_id, i + 1]))

  const gains = new Map<number, number>()
  for (const e of gainEvents) {
    if (e.event_type !== 'claimed' && e.event_type !== 'conquered')
      continue
    const t = timestampMs(e.created_at)
    if (Number.isNaN(t) || t < since || t > now)
      continue
    gains.set(e.user_id, (gains.get(e.user_id) ?? 0) + (e.area_at_event ?? 0))
  }

  const weeklyOrder = [...players].sort((a, b) =>
    (gains.get(b.user_id) ?? 0) - (gains.get(a.user_id) ?? 0)
    || (allTimeRank.get(a.user_id) ?? 0) - (allTimeRank.get(b.user_id) ?? 0))
  const weeklyRank = new Map(weeklyOrder.map((s, i) => [s.user_id, i + 1]))

  return players.map(s => ({
    id: s.id,
    user_id: s.user_id,
    weekly_rank: weeklyRank.get(s.user_id) ?? 0,
    all_time_rank: allTimeRank.get(s.user_id) ?? 0,
  }))
}

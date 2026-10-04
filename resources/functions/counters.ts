/**
 * Pure denormalized-counter math (#973): `activities.kudos_count` from kudos
 * rows, `trails.rating`/`review_count` from trail reviews. Returns only the
 * rows whose persisted counters drifted from the recomputed truth, so callers
 * write the minimum. Ratings are the mean rounded to 1 decimal; a trail with
 * no reviews is honestly 0/0 (not a factory number).
 */

export interface ActivityCounterRow { id: number, kudos_count?: number | null }
export interface KudosCounterRow { activity_id?: number | null }
export interface TrailCounterRow { id: number, rating?: number | null, review_count?: number | null }
export interface ReviewCounterRow { trail_id?: number | null, rating?: number | null }

export interface CounterFixes {
  activityFixes: Array<{ id: number, kudos_count: number }>
  trailFixes: Array<{ id: number, rating: number, review_count: number }>
}

export function computeCounterFixes(input: {
  activities: ActivityCounterRow[]
  kudos: KudosCounterRow[]
  trails: TrailCounterRow[]
  reviews: ReviewCounterRow[]
}): CounterFixes {
  const kudosByActivity = new Map<number, number>()
  for (const k of input.kudos) {
    if (k.activity_id != null)
      kudosByActivity.set(k.activity_id, (kudosByActivity.get(k.activity_id) ?? 0) + 1)
  }

  const activityFixes: CounterFixes['activityFixes'] = []
  for (const a of input.activities) {
    const real = kudosByActivity.get(a.id) ?? 0
    if ((a.kudos_count ?? 0) !== real)
      activityFixes.push({ id: a.id, kudos_count: real })
  }

  const ratingSums = new Map<number, { sum: number, n: number }>()
  for (const r of input.reviews) {
    if (r.trail_id == null || typeof r.rating !== 'number')
      continue
    const s = ratingSums.get(r.trail_id) ?? { sum: 0, n: 0 }
    s.sum += r.rating
    s.n++
    ratingSums.set(r.trail_id, s)
  }

  const trailFixes: CounterFixes['trailFixes'] = []
  for (const t of input.trails) {
    const s = ratingSums.get(t.id)
    const reviewCount = s?.n ?? 0
    const rating = s ? Math.round((s.sum / s.n) * 10) / 10 : 0
    if ((t.review_count ?? 0) !== reviewCount || (t.rating ?? 0) !== rating)
      trailFixes.push({ id: t.id, rating, review_count: reviewCount })
  }

  return { activityFixes, trailFixes }
}

/*
 * Territory holdings (`territory_stats`).
 *
 * Claims, battles and decay each adjust a player's holdings by a delta inside
 * their own transaction, and a delta can only ever be as right as the row it
 * was applied to: a clamp at zero, a split that moved area between two
 * players, an expiry swept twice. So the holdings — how many territories a
 * player owns now, how much ground, and the largest piece — are rebuilt here
 * from the territories themselves.
 *
 * The lifetime counters (claimed, conquered, lost, defended, XP) are history,
 * not state, and are left alone: nothing stored records every event they
 * count, so a rebuild could only make them wrong in a new way.
 */

export interface TerritoryStatsRow {
  id: number
  user_id: number | null
  total_territories_owned?: number | null
  total_area_owned?: number | null
  largest_territory_area?: number | null
}

/** One player's live holdings: `territories` grouped by owner, active or contested. */
export interface HoldingRow {
  user_id: number
  owned: number
  area: number
  largest: number
}

export interface TerritoryStatsFixes {
  /** Rows whose holdings drifted, with the values they should hold. */
  updates: Array<{ id: number, total_territories_owned: number, total_area_owned: number, largest_territory_area: number }>
  /** Rows for players who no longer exist. */
  orphans: number[]
  /** Players who hold ground and have no stats row at all. */
  missing: HoldingRow[]
}

/** Square metres two areas may differ by and still be the same area. */
const AREA_TOLERANCE = 0.5

export function computeTerritoryStatsFixes(input: {
  stats: TerritoryStatsRow[]
  holdings: HoldingRow[]
  /** Ids of every player who still exists. */
  userIds: Set<number>
}): TerritoryStatsFixes {
  const held = new Map(input.holdings.map(row => [Number(row.user_id), row]))
  const updates: TerritoryStatsFixes['updates'] = []
  const orphans: number[] = []
  const seen = new Set<number>()

  for (const row of input.stats) {
    const userId = Number(row.user_id)
    if (row.user_id == null || !input.userIds.has(userId)) {
      orphans.push(row.id)
      continue
    }
    seen.add(userId)

    const holding = held.get(userId)
    const owned = holding?.owned ?? 0
    const area = holding?.area ?? 0
    // Largest is a lifetime best, so it only ever rises to what is held now.
    const largest = Math.max(row.largest_territory_area ?? 0, holding?.largest ?? 0)

    if ((row.total_territories_owned ?? 0) !== owned
      || Math.abs((row.total_area_owned ?? 0) - area) > AREA_TOLERANCE
      || Math.abs((row.largest_territory_area ?? 0) - largest) > AREA_TOLERANCE) {
      updates.push({ id: row.id, total_territories_owned: owned, total_area_owned: area, largest_territory_area: largest })
    }
  }

  const missing = input.holdings.filter(row => input.userIds.has(Number(row.user_id)) && !seen.has(Number(row.user_id)))

  return { updates, orphans, missing }
}

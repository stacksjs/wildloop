import type { CounterFixes, HoldingRow, TerritoryStatsFixes } from '../../resources/functions/counters'
import { db } from '@stacksjs/orm'
import { computeCounterFixes, computeTerritoryStatsFixes } from '../../resources/functions/counters'
import { segmentElevationFixes } from './segmentElevationRepair'
import { inWriteTransaction } from './writeTransaction'

export interface CounterRepairReport {
  activitiesFixed: number
  trailsFixed: number
  territoryStatsFixed: number
  territoryStatsRemoved: number
  territoryStatsCreated: number
  segmentsFixed: number
  /** Rows read to decide, for the log. */
  activitiesTotal: number
  trailsTotal: number
}

/**
 * Rebuild every denormalized counter from the rows it summarises: kudos on
 * activities, ratings on trails, players' territory holdings, and the climb on
 * segments cut from runs uploaded while the recorder sent feet.
 *
 * Shared by `buddy counters:recompute` (the 04:10 job) and the admin
 * endpoint.
 *
 * Reads only the columns the math needs. The previous version called
 * `Trail.all()` and `Activity.all()`, which deserialised all 596,556 trails
 * with their geometry, and every activity with its whole GPS track, every
 * night to fix a handful of counters. A trail's rating can only be out of
 * line if it has reviews or claims to, so only those trails are read.
 *
 * Writes go in one transaction: a sweep that stops halfway leaves the
 * counters as they were rather than half rebuilt.
 */
export async function repairCounters(options: { dryRun?: boolean, log?: (line: string) => void } = {}): Promise<CounterRepairReport> {
  const log = options.log ?? (() => {})

  const [activities, kudos, trails, reviews, stats, holdings, users] = await Promise.all([
    db.sql`SELECT id, kudos_count FROM activities`.execute(),
    db.sql`SELECT activity_id FROM kudos`.execute(),
    db.sql`
      SELECT id, rating, review_count FROM trails
      WHERE review_count > 0 OR rating > 0
         OR id IN (SELECT trail_id FROM trail_reviews WHERE trail_id IS NOT NULL)
    `.execute(),
    db.sql`SELECT trail_id, rating FROM trail_reviews`.execute(),
    db.sql`SELECT id, user_id, total_territories_owned, total_area_owned, largest_territory_area FROM territory_stats`.execute(),
    db.sql`
      SELECT user_id, COUNT(*) AS owned, COALESCE(SUM(area_size), 0) AS area, COALESCE(MAX(area_size), 0) AS largest
      FROM territories
      WHERE status IN ('active', 'contested') AND user_id IS NOT NULL
      GROUP BY user_id
    `.execute(),
    db.sql`SELECT id FROM users`.execute(),
  ]) as any[][]

  const counters: CounterFixes = computeCounterFixes({ activities, kudos, trails, reviews })
  const territory: TerritoryStatsFixes = computeTerritoryStatsFixes({
    stats,
    holdings: (holdings as HoldingRow[]).map(row => ({
      user_id: Number(row.user_id),
      owned: Number(row.owned),
      area: Number(row.area),
      largest: Number(row.largest),
    })),
    userIds: new Set((users ?? []).map((row: any) => Number(row.id))),
  })

  // Climb on segments cut from runs uploaded while the recorder sent feet.
  const segments = await segmentElevationFixes()

  const suffix = options.dryRun ? ' (dry run)' : ''
  for (const f of counters.activityFixes)
    log(`  activity ${f.id}: kudos_count → ${f.kudos_count}${suffix}`)
  for (const f of counters.trailFixes)
    log(`  trail ${f.id}: rating → ${f.rating}, review_count → ${f.review_count}${suffix}`)
  for (const f of territory.updates)
    log(`  territory_stats ${f.id}: owned → ${f.total_territories_owned}, area → ${Math.round(f.total_area_owned)} m²${suffix}`)
  for (const id of territory.orphans)
    log(`  territory_stats ${id}: removed, its player no longer exists${suffix}`)
  for (const row of territory.missing)
    log(`  territory_stats for user ${row.user_id}: created, holding ${row.owned}${suffix}`)
  for (const f of segments)
    log(`  segment ${f.id}: elevation → ${f.elevation} ft${suffix}`)

  if (!options.dryRun) {
    const now = new Date().toISOString()
    await inWriteTransaction(async () => {
      for (const f of counters.activityFixes)
        await db.sql`UPDATE activities SET kudos_count = ${f.kudos_count} WHERE id = ${f.id}`.execute()
      for (const f of counters.trailFixes)
        await db.sql`UPDATE trails SET rating = ${f.rating}, review_count = ${f.review_count} WHERE id = ${f.id}`.execute()
      for (const f of territory.updates) {
        await db.sql`
          UPDATE territory_stats
          SET total_territories_owned = ${f.total_territories_owned}, total_area_owned = ${f.total_area_owned},
              largest_territory_area = ${f.largest_territory_area}, updated_at = ${now}
          WHERE id = ${f.id}
        `.execute()
      }
      for (const id of territory.orphans)
        await db.sql`DELETE FROM territory_stats WHERE id = ${id}`.execute()
      for (const row of territory.missing) {
        // Lifetime counters start at what is visibly true: they claimed at
        // least what they hold.
        await db.sql`
          INSERT INTO territory_stats (user_id, total_territories_owned, total_area_owned, territories_claimed,
            territories_conquered, territories_lost, territories_defended, longest_ownership_days,
            largest_territory_area, xp, created_at, updated_at)
          VALUES (${row.user_id}, ${row.owned}, ${row.area}, ${row.owned}, 0, 0, 0, 0, ${row.largest}, 0, ${now}, ${now})
        `.execute()
      }
      for (const f of segments)
        await db.sql`UPDATE segments SET elevation = ${f.elevation}, updated_at = ${now} WHERE id = ${f.id}`.execute()
    })
  }

  return {
    activitiesFixed: counters.activityFixes.length,
    trailsFixed: counters.trailFixes.length,
    territoryStatsFixed: territory.updates.length,
    territoryStatsRemoved: territory.orphans.length,
    territoryStatsCreated: territory.missing.length,
    segmentsFixed: segments.length,
    activitiesTotal: activities.length,
    trailsTotal: trails.length,
  }
}

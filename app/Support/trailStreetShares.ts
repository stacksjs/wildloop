import { db } from '@stacksjs/orm'

/**
 * Where each OSM relation's street share is kept (`trail_street_shares`,
 * migration 0000000198), and where ranking reads it back.
 *
 * What the share is and how it is measured: app/Support/streetShare.ts.
 * What ranking does with it: `streetAppeal` in app/Support/trailRanking.ts.
 */

/** A measured route, by the key the ingest knows it by. */
export interface MeasuredRoute {
  sourceId: string
  streetShare?: number | null
}

/**
 * Record the street share of each route that has one, as one statement.
 *
 * Routes left unmeasured (`streetShare` undefined) are skipped, so a source
 * that measures nothing leaves what is stored alone. Rows are matched to
 * trails by `(source, source_id)`, so call this after the trails are written:
 * a route with no trail row yet records nothing.
 */
export async function recordStreetShares(source: string, routes: MeasuredRoute[], at = new Date().toISOString()): Promise<void> {
  const measured = routes
    .filter(route => route.streetShare !== undefined)
    .map(route => ({
      sourceId: route.sourceId,
      share: route.streetShare === null || !Number.isFinite(Number(route.streetShare)) ? null : Number(route.streetShare),
    }))
  if (measured.length === 0)
    return

  // `WHERE true` is SQLite's own advice for an upsert fed by a SELECT with a
  // join: without it, `ON CONFLICT` is read as part of the join.
  await db.sql`
    INSERT INTO trail_street_shares (trail_id, share, measured_at)
    SELECT t.id, json_extract(m.value, '$.share'), ${at}
    FROM json_each(${JSON.stringify(measured)}) m
    JOIN trails t ON t.source = ${source} AND t.source_id = json_extract(m.value, '$.sourceId')
    WHERE true
    ON CONFLICT (trail_id) DO UPDATE SET share = excluded.share, measured_at = excluded.measured_at
  `.execute()
}

/**
 * The street share of each of these trails that has one.
 *
 * A failed read costs ranking this one signal and nothing else, like the
 * engagement it is read beside: an unmeasured trail ranks as it always did.
 */
export async function trailStreetShares(trailIds: number[]): Promise<Map<number, number>> {
  const shares = new Map<number, number>()
  const ids = [...new Set(trailIds.map(Number).filter(id => Number.isInteger(id) && id > 0))]
  if (ids.length === 0)
    return shares

  const rows = await db.sql`
    SELECT trail_id, share FROM trail_street_shares
    WHERE trail_id IN (SELECT value FROM json_each(${JSON.stringify(ids)})) AND share > 0
  `.execute().catch(() => []) as Array<{ trail_id: number, share: number }>

  for (const row of rows ?? [])
    shares.set(Number(row.trail_id), Number(row.share))

  return shares
}

import Trail from '../../app/Models/Trail'
import { trailIdBySeedSourceId } from '../seeders/TrailSeeder'

/**
 * Loading only the trails a seeder actually needs.
 *
 * Six seeders reached for `Trail.all()`. That is fine against the twenty-five
 * trails a fresh database holds and indefensible against the catalog a real
 * ingest builds: the deployed environment carries ~593,000 rows, geometry
 * strings included, and three of those seeders would each have pulled the
 * whole table into memory to look up a handful of trails by name.
 *
 * It lives outside `seeders/` because the seed runner treats every file in
 * that directory as a seeder and refuses one whose default export is not a
 * Seeder class.
 *
 * Nothing here is a sampling shortcut. Every seeder below wants a specific,
 * small, knowable set — the trails the seed data names, or the trails the
 * seeded activities were run on — so the query says so.
 */

/**
 * SQLite's default parameter limit is 999. Chunking keeps a long id list from
 * failing as one oversized `IN (…)`, which is the kind of thing that works
 * everywhere it is tested and breaks on the one database that has real data.
 */
const CHUNK = 500

function chunked<T>(values: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += CHUNK)
    out.push(values.slice(i, i + CHUNK))
  return out
}

/** The trails with these ids. Empty in, empty out — never "all of them". */
export async function trailsByIds(ids: Array<number | null | undefined>): Promise<any[]> {
  const unique = [...new Set(ids.filter((id): id is number => typeof id === 'number'))]
  if (unique.length === 0)
    return []

  const rows: any[] = []
  for (const batch of chunked(unique))
    rows.push(...((await Trail.whereIn('id', batch).get().catch(() => [])) as any[]))

  return rows
}

/**
 * The trails TrailSeeder is responsible for — the ones it inserted, plus the
 * ones it adopted from the catalog because they were already there.
 *
 * Falls back to a lookup by source id for the case where TrailSeeder did not
 * run in this process (`--only-seeders ReviewSeeder`, say), so a partial seed
 * still resolves its trails instead of silently linking nothing.
 */
export async function seededTrails(sourceIds: string[]): Promise<any[]> {
  const known = sourceIds
    .map(sourceId => trailIdBySeedSourceId.get(sourceId))
    .filter((id): id is number => typeof id === 'number')

  const byId = await trailsByIds(known)

  // Only look up source ids the map could not answer. Fetching one it HAS
  // answered drags the superseded row back in — the seeder's own pre-ingest
  // copy still carries that source id, and a caller checking source ids first
  // would then resolve to the row we are trying to retire.
  const missing = [...new Set(sourceIds)].filter(sourceId => !trailIdBySeedSourceId.has(sourceId))
  if (missing.length === 0)
    return byId

  const bySourceId: any[] = []
  for (const batch of chunked(missing))
    bySourceId.push(...((await Trail.whereIn('source_id', batch).get().catch(() => [])) as any[]))

  const seen = new Set(byId.map(trail => trail.id))
  return [...byId, ...bySourceId.filter(trail => !seen.has(trail.id))]
}

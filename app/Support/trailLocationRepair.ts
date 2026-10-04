import type { LocationDecision, ManagedNeighbour, NearbyTown, TrailPlace } from './trailLocation'
import { db } from '@stacksjs/orm'
import { openGazetteer } from './gazetteer'
import { betterLocation, MANAGED_SEARCH_KM, namesOnlyRegion } from './trailLocation'
import { inWriteTransaction } from './writeTransaction'

/**
 * The database and gazetteer side of naming a trail's place: look up what is
 * around a trail, ask `betterLocation()`, and write the answer without
 * leaving the search index behind.
 *
 * Shared by the ingest, which names a trail as it is written, and by
 * `trails:repair-locations`, which names the ones written before it did.
 */

/** Towns asked of the gazetteer per trail: enough to step past a few over the border. */
const TOWN_CANDIDATES = 8

/**
 * Agency trails read per lookup. A park's densest corner has a few hundred
 * within the search box; this only stops a pathological one reading
 * thousands.
 */
const MANAGED_CANDIDATES = 2000

/** Where the answer for one trail came from, or why there is none. */
export type LocationOutcome
  = | { status: 'better', decision: LocationDecision }
    /** The location already names something finer than the region. */
    | { status: 'specific' }
    /** Looked, and nothing near enough to name it by. */
    | { status: 'unnamed' }
    /** The gazetteer is not built, so a town could not be asked for. Not an answer. */
    | { status: 'unavailable' }

/**
 * Agency trails around a point — the Park Service and Forest Service rows,
 * which carry their unit's name. Served by `trails_lat_lng_index`.
 *
 * The `+` on `source` is load-bearing. Without it SQLite prefers the
 * `(source, source_id)` unique index for the IN list and reads every agency
 * row in the country to find the dozen near this point: on a 600,000-row
 * catalog that was 200 ms a trail, and a night's slice did not finish.
 */
export async function managedNeighbours(point: { lat: number, lng: number }): Promise<ManagedNeighbour[]> {
  const dLat = MANAGED_SEARCH_KM / 110.57
  const dLng = MANAGED_SEARCH_KM / (111.32 * Math.max(0.05, Math.cos(point.lat * Math.PI / 180)))
  const rows = await db.sql`
    SELECT location, latitude, longitude
    FROM trails
    WHERE latitude BETWEEN ${point.lat - dLat} AND ${point.lat + dLat}
      AND longitude BETWEEN ${point.lng - dLng} AND ${point.lng + dLng}
      AND +source IN ('nps', 'usfs')
    LIMIT ${MANAGED_CANDIDATES}
  `.execute() as Array<{ location: string, latitude: number, longitude: number }>
  return (rows ?? []).map(row => ({
    location: String(row.location ?? ''),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
  }))
}

/** The nearest gazetteer places, or null when the gazetteer is not built. */
export function townsNear(point: { lat: number, lng: number }): NearbyTown[] | null {
  const gazetteer = openGazetteer()
  if (!gazetteer)
    return null
  try {
    const hits = gazetteer.reverseSync(point, { limit: TOWN_CANDIDATES }) as Array<{
      center?: { lat?: number, lng?: number }
      properties?: { name?: string, distanceKm?: number }
    }>
    return hits
      .map(hit => ({
        name: String(hit.properties?.name ?? ''),
        lat: Number(hit.center?.lat),
        lng: Number(hit.center?.lng),
        distanceKm: Number(hit.properties?.distanceKm),
      }))
      .filter(town => town.name && Number.isFinite(town.lat) && Number.isFinite(town.lng) && Number.isFinite(town.distanceKm))
  }
  catch {
    return null
  }
}

/** Decide one trail's location, looking up what is around it. */
export async function locateTrail(row: TrailPlace): Promise<LocationOutcome> {
  if (!namesOnlyRegion(row))
    return { status: 'specific' }

  const point = { lat: row.latitude, lng: row.longitude }
  const towns = townsNear(point)
  const managed = row.country === 'US' ? await managedNeighbours(point) : []
  const decision = betterLocation(row, { managed, towns: towns ?? [] })

  if (decision)
    return { status: 'better', decision }
  // No agency label, and the town could not be asked for: the question is
  // still open, so a later run with the gazetteer in place asks it again.
  if (!towns)
    return { status: 'unavailable' }
  return { status: 'unnamed' }
}

/** Whether an outcome settles the question until the trail changes. */
export function isSettled(outcome: LocationOutcome): boolean {
  return outcome.status !== 'unavailable'
}

export interface LocationWrite {
  id: number
  /** The location the decision was made from. The write only lands if it is still this. */
  from: string
  to: string
}

/**
 * Write new locations, and mark rows answered.
 *
 * One transaction, for the same reason the ingest uses one: the search index
 * has to be retracted with the old terms and re-added with the new, and an
 * FTS 'rebuild' committing in between (TrailSeeder does one) would leave the
 * index holding terms the table no longer has.
 *
 * Each write is conditional on the location still being what it was decided
 * from, so a trail the ingest refreshed in the meantime keeps the ingest's
 * answer. Returns how many locations were written.
 */
export async function writeLocations(writes: LocationWrite[], settledIds: number[], at: string): Promise<number> {
  if (writes.length === 0 && settledIds.length === 0)
    return 0

  return inWriteTransaction(async () => {
    let written = 0

    if (writes.length > 0) {
      const ids = writes.map(write => Number(write.id)).filter(Number.isInteger)
      const current = await db.sql`
        SELECT id, name, location, state_name FROM trails WHERE id IN (${db.unsafe(ids.join(',') || '0')})
      `.execute() as Array<{ id: number, name: string, location: string, state_name: string }>
      const byId = new Map((current ?? []).map(row => [Number(row.id), row]))

      const landed: number[] = []
      for (const write of writes) {
        const row = byId.get(Number(write.id))
        if (!row || String(row.location ?? '') !== write.from)
          continue

        // Retract with the values as they are now — FTS5 cannot recover the
        // old terms itself — then write, then index the new ones below.
        await db.sql`
          INSERT INTO trails_fts(trails_fts, rowid, name, location, state_name)
          VALUES ('delete', ${row.id}, ${row.name}, ${row.location}, ${row.state_name})
        `.execute()
        await db.sql`
          UPDATE trails SET location = ${write.to}, location_checked_at = ${at}
          WHERE id = ${row.id} AND location = ${write.from}
        `.execute()
        landed.push(Number(row.id))
      }

      if (landed.length > 0) {
        await db.sql`
          INSERT INTO trails_fts(rowid, name, location, state_name)
          SELECT id, name, location, state_name FROM trails WHERE id IN (${db.unsafe(landed.join(','))})
        `.execute()
      }
      written = landed.length
    }

    const settled = settledIds.map(Number).filter(Number.isInteger)
    if (settled.length > 0) {
      await db.sql`
        UPDATE trails SET location_checked_at = ${at}
        WHERE id IN (${db.unsafe(settled.join(','))}) AND location_checked_at IS NULL
      `.execute()
    }

    return written
  })
}

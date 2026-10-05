import type { LocationDecision, ManagedNeighbour, NearbyTown, TrailPlace } from './trailLocation'
import process from 'node:process'
import { db } from '@stacksjs/orm'
import { ValhallaElevation } from 'ts-maps/services'
import { openGazetteer } from './gazetteer'
import { betterLocation, crossesRidge, kmBetween, MANAGED_SEARCH_KM, namesOnlyRegion, pointsBetween, TOWN_SEARCH_KM, unitKey } from './trailLocation'
import { inWriteTransaction } from './writeTransaction'

/**
 * The database and gazetteer side of naming a trail's place: look up what is
 * around a trail, ask `betterLocation()`, and write the answer without
 * leaving the search index behind.
 *
 * Shared by the ingest, which names a trail as it is written, and by
 * `trails:repair-locations`, which names the ones written before it did.
 */

/**
 * Towns kept per trail, nearest first: enough to step past every one over the
 * border. Eight was not. On the Swiss and Austrian borders and between small
 * cantons the eight nearest places were all on the other side, and 764
 * trails with a town of their own region within 25 km were left unnamed.
 */
const TOWN_CANDIDATES = 60

/**
 * Agency trails read per lookup. A park's densest corner has a few thousand
 * within the 10 km search box; this only stops a pathological one reading
 * tens of thousands.
 */
const MANAGED_CANDIDATES = 5000

/** How long the list of agency units is trusted before it is read again. */
const UNITS_TTL_MS = 60 * 60 * 1000

/** Our routing server answers a height profile in tens of milliseconds; this is for when it does not. */
const HEIGHTS_TIMEOUT_MS = 3500

/**
 * Failures in a row after which the routing server is left alone for
 * `HEIGHTS_PAUSE_MS`. A night's run asks some 15,000 times; at the timeout
 * each, a server that is down would hold the job for half a day. The pause
 * ends, rather than lasting the process, for the long-lived ingest worker.
 */
const HEIGHTS_MAX_FAILURES = 5
const HEIGHTS_PAUSE_MS = 10 * 60 * 1000

/** Where the answer for one trail came from, or why there is none. */
export type LocationOutcome
  = | { status: 'better', decision: LocationDecision }
    /** The location already names something finer than the region. */
    | { status: 'specific' }
    /** Looked, and nothing near enough to name it by. */
    | { status: 'unnamed' }
    /**
     * The gazetteer is not built, so a town could not be asked for, or the
     * routing server could not say whether a ridge lies between a trail and
     * the town it would be near. Not an answer.
     */
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

/**
 * The gazetteer places within `TOWN_SEARCH_KM`, nearest first, or null when
 * the gazetteer is not built.
 *
 * Read from its table rather than through `reverseSync()`, which returns 25
 * at most and not the feature code — and the code is what tells a town from
 * a section of a city, which is no place to be "near".
 */
export function townsNear(point: { lat: number, lng: number }): NearbyTown[] | null {
  const gazetteer = openGazetteer()
  if (!gazetteer)
    return null
  try {
    const dLat = TOWN_SEARCH_KM / 110.57
    const dLng = TOWN_SEARCH_KM / (111.32 * Math.max(0.05, Math.cos(point.lat * Math.PI / 180)))
    const rows = gazetteer.db.query(`
      SELECT name, lat, lng, feature, country, region_code FROM gazetteer_places
      WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?
    `).all(point.lat - dLat, point.lat + dLat, point.lng - dLng, point.lng + dLng) as Array<{
      name: string
      lat: number
      lng: number
      feature: string | null
      country: string | null
      region_code: string | null
    }>
    return rows
      .map(row => ({
        name: String(row.name ?? '').trim(),
        lat: Number(row.lat),
        lng: Number(row.lng),
        feature: row.feature ?? null,
        country: row.country ?? null,
        regionCode: row.region_code ?? null,
        distanceKm: kmBetween(point, { lat: Number(row.lat), lng: Number(row.lng) }),
      }))
      .filter(town => town.name && Number.isFinite(town.distanceKm) && town.distanceKm <= TOWN_SEARCH_KM)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .slice(0, TOWN_CANDIDATES)
  }
  catch {
    return null
  }
}

let units: { at: number, byKey: Map<string, string> } | null = null

/**
 * Every unit the agency rows name, by `unitKey()`, each to its own spelling:
 * "mount baker snoqualmie national forest" to "Mt. Baker-Snoqualmie National
 * Forest". What an operator tag naming a federal unit is checked against.
 *
 * Some 500 labels from 56,000 rows, read through the `(source, source_id)`
 * index and kept for an hour, so a night's run and a long-lived ingest
 * worker read it once or twice.
 */
export async function agencyUnits(): Promise<Map<string, string>> {
  if (units && Date.now() - units.at < UNITS_TTL_MS)
    return units.byKey
  const rows = await db.sql`
    SELECT DISTINCT location FROM trails WHERE source IN ('nps', 'usfs')
  `.execute() as Array<{ location: string | null }>
  const byKey = new Map<string, string>()
  for (const row of rows ?? []) {
    // "Colville National Forest, WA": the unit is everything before the state.
    const label = String(row.location ?? '').trim()
    const unit = label.replace(/,\s*[A-Z]{2}$/, '').trim()
    if (unit && unit !== label && !byKey.has(unitKey(unit)))
      byKey.set(unitKey(unit), unit)
  }
  units = { at: Date.now(), byKey }
  return byKey
}

let heightFailures = 0
let heightsPausedUntil = 0

/**
 * Ground heights in metres at each point, from our own routing server, or
 * null when it cannot be asked.
 *
 * Only `VALHALLA_URL`, never the public fallback the route builder uses: this
 * runs for thousands of trails a night, and that server is somebody else's
 * (see `trails:repair-elevation`). Without our own, no town more than
 * `RIDGE_CHECK_FROM_KM` off is named.
 */
export async function heightsAlong(points: Array<{ lat: number, lng: number }>): Promise<Array<number | null> | null> {
  const baseUrl = process.env.VALHALLA_URL?.trim()
  if (!baseUrl || Date.now() < heightsPausedUntil)
    return null
  try {
    const heights = await new ValhallaElevation({ baseUrl })
      .getElevations(points, { signal: AbortSignal.timeout(HEIGHTS_TIMEOUT_MS) })
    heightFailures = 0
    return heights
  }
  catch {
    heightFailures++
    if (heightFailures >= HEIGHTS_MAX_FAILURES) {
      heightFailures = 0
      heightsPausedUntil = Date.now() + HEIGHTS_PAUSE_MS
    }
    return null
  }
}

/** Decide one trail's location, looking up what is around it. */
export async function locateTrail(
  row: TrailPlace,
  ask: { heights?: typeof heightsAlong } = {},
): Promise<LocationOutcome> {
  if (!namesOnlyRegion(row))
    return { status: 'specific' }

  const point = { lat: row.latitude, lng: row.longitude }
  const towns = townsNear(point)
  const isUS = row.country === 'US'
  const managed = isUS ? await managedNeighbours(point) : []
  const known = isUS && String(row.managedBy ?? '').trim() ? await agencyUnits() : undefined
  const decision = betterLocation(row, { managed, towns: towns ?? [], units: known })

  // A town some way off is only where the trail is, or near it, if no ridge
  // stands between: Lunch Meadow is 36 km from Bridgeport, and the Sierra
  // crest is in the way. `betterLocation()` gives the town's point when the
  // ground has to be looked at.
  if (decision?.town) {
    const heights = await (ask.heights ?? heightsAlong)(pointsBetween(point, decision.town))
    const ridge = heights ? crossesRidge(heights) : null
    // Not known: ask again on a night the routing server answers.
    if (ridge === null)
      return { status: 'unavailable' }
    if (ridge)
      return { status: 'unnamed' }
  }

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

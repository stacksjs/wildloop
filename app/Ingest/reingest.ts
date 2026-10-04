/**
 * Asking for one region to be ingested again, without doing any of the work.
 *
 * The ingest worker already does the work: it claims shards from
 * `trail_ingest_shards` forever and re-syncs each one monthly. What nothing
 * could do until now is say "this region, now" from outside the box (#976).
 * This file is that request and nothing more — it writes shard rows back to
 * `pending` and returns. It never fetches, so an HTTP request asking for it
 * finishes in milliseconds, and a region of a hundred Overpass tiles is the
 * worker's next few hours rather than the request's.
 *
 * Three limits keep it from being a way to spend the Overpass budget on a
 * whim:
 *
 *  - **Only regions the catalog covers.** A region is a code from `regions.ts`
 *    and its tiles are the OSM shards the worker would sweep anyway, so there
 *    is no way to name an arbitrary box.
 *  - **Re-entrant.** A tile is one row, keyed on `shard_key`. Asking again for
 *    a region that is already queued finds its tiles pending and adds nothing.
 *  - **Nothing fresh.** A tile finished within the last day is left alone, so
 *    asking twice either side of the worker reaching it does not fetch it
 *    twice.
 *
 * OSM only. The Forest Service and Park Service shards are paged by forest
 * and park unit, not by area, so they have no region to be re-asked by — and
 * they are a few hundred cheap requests that `trails:requeue` already redoes
 * wholesale.
 */

import type { RegionMatch, RegionPolygon } from './regions'
import type { Shard } from './types'
import { regionContains, regionPolygon } from './regions'
import { osmSource } from './sources/osm'

/**
 * The most tiles one request may put into the queue.
 *
 * About the size of Colorado. At two Overpass requests a minute that is under
 * an hour of the worker's time, which is the most a single ask should be able
 * to commit it to. Bigger regions are asked for in more than one go.
 */
export const REINGEST_MAX_TILES = 50

/** A tile finished this recently is not fetched again for the asking. */
export const REINGEST_FRESH_MS = 24 * 60 * 60 * 1000

/**
 * How finely a tile is sampled when deciding whether a region is really in it.
 *
 * Coarse for a big region: a point every eighth of a degree, about 14 km, so
 * a state whose border strays a few hundred metres over a gridline — Colorado
 * is drawn 0.05 degrees into Utah's tiles — is not charged a whole Overpass
 * request for the sliver. Finer for a small one, an eighth of its own size,
 * so the half of Washington DC east of the -77 gridline still counts.
 */
const SAMPLE_FRACTION = 1 / 8

/** Never more than this many samples a side, whatever the region's size. */
const MAX_SAMPLES_PER_SIDE = 64

/** The worker's tiles. Enumerating them is deterministic, so once is enough. */
let knownTiles: Shard[] | null = null

function regionReaches(region: RegionPolygon, tile: Record<string, number>): boolean {
  const { south, west, north, east } = tile
  const [minLng, minLat, maxLng, maxLat] = region.bbox
  if (east < minLng || west > maxLng || north < minLat || south > maxLat)
    return false

  const span = Math.min(maxLat - minLat, maxLng - minLng, 1)
  const perSide = Math.min(Math.ceil(1 / (span * SAMPLE_FRACTION)), MAX_SAMPLES_PER_SIDE)
  const latStep = (north - south) / perSide
  const lngStep = (east - west) / perSide
  for (let i = 0; i < perSide; i++) {
    for (let j = 0; j < perSide; j++) {
      if (regionContains(region, south + (i + 0.5) * latStep, west + (j + 0.5) * lngStep))
        return true
    }
  }
  return false
}

/**
 * The OSM tiles that cover a region, in the worker's own order, or `null` for
 * a code the catalog does not cover.
 *
 * A tile counts when a real share of it lies in the region (see
 * `SAMPLE_FRACTION`). A region too small for any sample to land in — Basel,
 * Bremen — is instead given the tiles its own outline passes through, so a
 * city-state is never answered with no tiles at all.
 *
 * Only shards the worker already knows are candidates, so this can never
 * produce a tile the ingest would not have fetched anyway.
 */
export function regionTiles(code: string): Shard[] | null {
  const region = regionPolygon(code)
  if (!region)
    return null

  knownTiles ??= osmSource.shards() as Shard[]
  const reached = knownTiles.filter(tile => regionReaches(region, tile.cursor as Record<string, number>))
  if (reached.length > 0)
    return reached

  const outline = new Set<string>()
  for (const ring of region.rings) {
    for (const [lng, lat] of ring)
      outline.add(`osm:${Math.floor(lat)},${Math.floor(lng)}`)
  }
  return knownTiles.filter(tile => outline.has(tile.key))
}

/** What the queue holds for one tile, as far as the plan needs to know. */
export interface ShardState {
  shard_key: string
  status: string
  completed_at: string | null
}

export interface ReingestPlan {
  /** Tiles with no row yet: a database the worker has not seeded. */
  create: Shard[]
  /** Finished or failed tiles to move back to `pending`. */
  requeue: string[]
  /** Already `pending`: asked for before, and not yet reached. */
  queued: string[]
  /** The worker is on these now. */
  running: string[]
  /** Finished within `REINGEST_FRESH_MS`, so not worth fetching again. */
  fresh: string[]
  /** Would have been queued, but past this request's limit. */
  deferred: string[]
}

/**
 * Decide what one request does, from the tiles and their rows.
 *
 * Pure, so re-entrancy is a property that can be checked without a database:
 * apply a plan, plan again from the result, and the second plan adds nothing.
 *
 * `limit` caps the tiles this request ADDS. Tiles already queued or in flight
 * cost nothing, which is what makes asking again a no-op rather than a second
 * helping, and what lets a region larger than one request be finished by
 * asking again: the next ask picks up where the deferred tiles begin.
 */
export function planReingest(tiles: Shard[], rows: ShardState[], options: { now: number, limit: number }): ReingestPlan {
  const byKey = new Map(rows.map(row => [row.shard_key, row]))
  const freshAfter = options.now - REINGEST_FRESH_MS
  const plan: ReingestPlan = { create: [], requeue: [], queued: [], running: [], fresh: [], deferred: [] }
  const budget = Math.max(0, Math.floor(options.limit))
  let added = 0

  for (const tile of tiles) {
    const row = byKey.get(tile.key)

    if (row?.status === 'pending') {
      plan.queued.push(tile.key)
      continue
    }
    if (row?.status === 'running') {
      plan.running.push(tile.key)
      continue
    }
    if (row?.status === 'done' && row.completed_at) {
      const completed = Date.parse(row.completed_at)
      if (Number.isFinite(completed) && completed > freshAfter) {
        plan.fresh.push(tile.key)
        continue
      }
    }

    if (added >= budget) {
      plan.deferred.push(tile.key)
      continue
    }
    added++
    if (row)
      plan.requeue.push(tile.key)
    else
      plan.create.push(tile)
  }

  return plan
}

/**
 * Where the plan is read from and written to. The real one is SQL against
 * `trail_ingest_shards`; tests pass an in-memory one, which is also how they
 * prove nothing here reaches the network.
 */
export interface ShardStore {
  read: (keys: string[]) => Promise<ShardState[]>
  /** Add rows for tiles that have none. Must ignore a key that already exists. */
  insert: (shards: Shard[], now: string) => Promise<void>
  /**
   * Move these tiles back to `pending`, but only if they are still finished
   * longer ago than `freshBefore` or failed — the worker may have claimed or
   * finished one since the plan read it, and that one should be left alone.
   */
  requeue: (keys: string[], freshBefore: string, now: string) => Promise<void>
}

export interface ReingestResult {
  region: RegionMatch
  source: 'osm'
  /** Every tile the region covers. */
  tiles: number
  /** Tiles this request put into the queue. */
  queued: number
  /** Tiles that were already queued or being fetched. */
  alreadyQueued: number
  /** Tiles left alone because they were finished within the last day. */
  recentlyDone: number
  /** Tiles past this request's limit; asking again queues the next of them. */
  deferred: number
}

/**
 * Queue a region's tiles for the worker, or `null` for a region the catalog
 * does not cover. Returns as soon as the rows are written.
 */
export async function reingestRegion(
  code: string,
  options: { limit?: number, now?: number } = {},
  store: ShardStore = sqlShardStore,
): Promise<ReingestResult | null> {
  const region = regionPolygon(code)
  const tiles = regionTiles(code)
  if (!region || !tiles)
    return null

  const now = options.now ?? Date.now()
  const limit = Math.min(Math.max(Math.floor(options.limit ?? REINGEST_MAX_TILES), 1), REINGEST_MAX_TILES)
  const plan = planReingest(tiles, await store.read(tiles.map(tile => tile.key)), { now, limit })
  const stamp = new Date(now).toISOString()

  if (plan.create.length > 0)
    await store.insert(plan.create, stamp)
  if (plan.requeue.length > 0)
    await store.requeue(plan.requeue, new Date(now - REINGEST_FRESH_MS).toISOString(), stamp)

  return {
    region: { country: region.country, code: region.code, name: region.name },
    source: 'osm',
    tiles: tiles.length,
    queued: plan.create.length + plan.requeue.length,
    alreadyQueued: plan.queued.length + plan.running.length,
    recentlyDone: plan.fresh.length,
    deferred: plan.deferred.length,
  }
}

/** A list of shard keys for an `IN (...)`. Keys are ours, but quoted anyway. */
function keyList(keys: string[]): string {
  return keys.map(key => `'${key.replace(/'/g, '\'\'')}'`).join(',')
}

/** `trail_ingest_shards`, as the worker reads it. */
export const sqlShardStore: ShardStore = {
  async read(keys) {
    if (keys.length === 0)
      return []
    const { db } = await import('@stacksjs/orm')
    return await db.sql`
      SELECT shard_key, status, completed_at FROM trail_ingest_shards
      WHERE shard_key IN (${db.unsafe(keyList(keys))})
    `.execute() as ShardState[]
  },

  async insert(shards, now) {
    const { db } = await import('@stacksjs/orm')
    // The same row `seedShards` writes, so the worker cannot tell the
    // difference — and `insertOrIgnore`, so a seed racing this one is harmless.
    await db.insertOrIgnore('trail_ingest_shards', shards.map(shard => ({
      uuid: crypto.randomUUID(),
      shard_key: shard.key,
      source: shard.source,
      cursor: JSON.stringify(shard.cursor),
      status: 'pending',
      attempts: 0,
      features_seen: 0,
      trails_imported: 0,
      trails_updated: 0,
      created_at: now,
      updated_at: now,
    })))
  },

  async requeue(keys, freshBefore, now) {
    const { db } = await import('@stacksjs/orm')
    // Attempts back to zero: somebody asked for this tile, so a shard parked
    // after five failures gets its five tries again rather than one.
    await db.sql`
      UPDATE trail_ingest_shards
      SET status = 'pending', attempts = 0, updated_at = ${now}
      WHERE shard_key IN (${db.unsafe(keyList(keys))})
        AND (status = 'failed' OR (status = 'done' AND (completed_at IS NULL OR completed_at < ${freshBefore})))
    `.execute()
  },
}

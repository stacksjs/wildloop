import type { ShardState, ShardStore } from '../../app/Ingest/reingest'
import type { Shard } from '../../app/Ingest/types'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planReingest, REINGEST_FRESH_MS, REINGEST_MAX_TILES, regionTiles, reingestRegion } from '../../app/Ingest/reingest'
import { osmSource } from '../../app/Ingest/sources/osm'

/**
 * Asking for a region to be ingested again (#976).
 *
 * The request only writes shard rows; the worker does the fetching. So what
 * is worth proving is the shape of what gets written: only tiles the worker
 * already knows, only for regions the catalog covers, never twice, never a
 * tile finished a moment ago, never more than one request's share — and no
 * network at all.
 */

const NOW = Date.parse('2026-10-04T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

/** Rows for the trail_ingest_shards table, kept in a Map. */
function memoryStore(initial: ShardState[] = []): ShardStore & { rows: Map<string, ShardState & { attempts: number }>, writes: number } {
  const rows = new Map(initial.map(row => [row.shard_key, { ...row, attempts: 0 }]))
  const store = {
    rows,
    writes: 0,
    async read(keys: string[]) {
      return keys.filter(key => rows.has(key)).map(key => ({ ...rows.get(key)! }))
    },
    async insert(shards: Shard[]) {
      store.writes++
      for (const shard of shards) {
        if (!rows.has(shard.key))
          rows.set(shard.key, { shard_key: shard.key, status: 'pending', completed_at: null, attempts: 0 })
      }
    },
    async requeue(keys: string[], freshBefore: string) {
      store.writes++
      for (const key of keys) {
        const row = rows.get(key)
        if (!row)
          continue
        const stale = row.status === 'failed' || (row.status === 'done' && (!row.completed_at || row.completed_at < freshBefore))
        if (stale)
          rows.set(key, { ...row, status: 'pending', attempts: 0 })
      }
    },
  }
  return store
}

/*
 * The request must queue and return, never fetch. Any call to fetch while
 * these tests run is a failure, however it is caught upstream.
 */
const realFetch = globalThis.fetch
let fetched: string[] = []
beforeEach(() => {
  fetched = []
  globalThis.fetch = (async (url: any) => {
    fetched.push(String(url))
    throw new Error('the reingest request reached the network')
  }) as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe('which tiles a region is', () => {
  it('answers nothing for a region the catalog does not cover', () => {
    // The guard against aiming the Overpass budget at somewhere arbitrary:
    // there is no way to name a box, only a region we already sweep.
    for (const code of ['XX', '', 'FR-IDF', 'US', 'osm:39,-105', '39,-105'])
      expect(regionTiles(code), code).toBeNull()
  })

  it('covers Colorado with its own tiles and not its neighbours\'', () => {
    const tiles = regionTiles('CO')!.map(tile => tile.key)
    // 37-41N by 102-109W is four rows of seven.
    expect(tiles).toHaveLength(28)
    expect(tiles).toContain('osm:39,-105') // Denver and Boulder
    // Colorado is drawn a few hundredths of a degree over its borders. A
    // sliver is not worth a whole Overpass request for a neighbour's tile.
    expect(tiles).not.toContain('osm:41,-105') // Wyoming
    expect(tiles).not.toContain('osm:36,-105') // New Mexico
    expect(tiles).not.toContain('osm:39,-110') // Utah
  })

  it('reads a code however it is typed', () => {
    expect(regionTiles(' co ')).toEqual(regionTiles('CO'))
    expect(regionTiles('de-by')).toEqual(regionTiles('DE-BY'))
  })

  it('gives a city-state the tiles it lies in, rather than none', () => {
    expect(regionTiles('DE-BE')!.map(tile => tile.key)).toEqual(['osm:52,13'])
    expect(regionTiles('CH-BS')!.map(tile => tile.key)).toEqual(['osm:47,7'])
    // DC straddles the -77 gridline, and both halves are real parts of it.
    expect(regionTiles('DC')!.map(tile => tile.key)).toEqual(['osm:38,-78', 'osm:38,-77'])
  })

  it('only ever names tiles the worker already knows', () => {
    const known = new Set((osmSource.shards() as Shard[]).map(shard => shard.key))
    for (const code of ['CO', 'AK', 'HI', 'DE-BY', 'CH-GR', 'AT-7'])
      expect(regionTiles(code)!.every(tile => known.has(tile.key)), code).toBe(true)
  })
})

describe('planning a request', () => {
  const tiles = regionTiles('CO')!

  it('queues every tile of a region the worker has never seeded', () => {
    const plan = planReingest(tiles, [], { now: NOW, limit: 50 })
    expect(plan.create).toHaveLength(28)
    expect(plan.requeue).toHaveLength(0)
  })

  it('leaves alone what is already queued or being fetched', () => {
    const rows: ShardState[] = [
      { shard_key: tiles[0].key, status: 'pending', completed_at: null },
      { shard_key: tiles[1].key, status: 'running', completed_at: null },
    ]
    const plan = planReingest(tiles.slice(0, 2), rows, { now: NOW, limit: 50 })
    expect(plan.queued).toEqual([tiles[0].key])
    expect(plan.running).toEqual([tiles[1].key])
    expect(plan.create).toHaveLength(0)
    expect(plan.requeue).toHaveLength(0)
  })

  it('does not fetch again a tile finished within the last day', () => {
    const rows: ShardState[] = [
      { shard_key: tiles[0].key, status: 'done', completed_at: new Date(NOW - HOUR).toISOString() },
      { shard_key: tiles[1].key, status: 'done', completed_at: new Date(NOW - REINGEST_FRESH_MS - HOUR).toISOString() },
      { shard_key: tiles[2].key, status: 'done', completed_at: null },
    ]
    const plan = planReingest(tiles.slice(0, 3), rows, { now: NOW, limit: 50 })
    expect(plan.fresh).toEqual([tiles[0].key])
    expect(plan.requeue).toEqual([tiles[1].key, tiles[2].key])
  })

  it('requeues a failed tile, which is most of why somebody would ask', () => {
    const rows: ShardState[] = [{ shard_key: tiles[0].key, status: 'failed', completed_at: null }]
    expect(planReingest(tiles.slice(0, 1), rows, { now: NOW, limit: 50 }).requeue).toEqual([tiles[0].key])
  })

  it('adds no more than its limit, and says how many it held back', () => {
    const plan = planReingest(tiles, [], { now: NOW, limit: 10 })
    expect(plan.create).toHaveLength(10)
    expect(plan.deferred).toHaveLength(18)
    // In the worker's order, so the next request carries on from here.
    expect(plan.create.map(tile => tile.key)).toEqual(tiles.slice(0, 10).map(tile => tile.key))
  })

  it('does not charge the limit for tiles that were already queued', () => {
    const rows = tiles.slice(0, 10).map(tile => ({ shard_key: tile.key, status: 'pending', completed_at: null }))
    const plan = planReingest(tiles, rows, { now: NOW, limit: 10 })
    expect(plan.queued).toHaveLength(10)
    expect(plan.create.map(tile => tile.key)).toEqual(tiles.slice(10, 20).map(tile => tile.key))
  })
})

describe('asking for a region', () => {
  it('queues the region and reports what it did', async () => {
    const store = memoryStore()
    const result = await reingestRegion('co', { now: NOW }, store)

    expect(result).toEqual({
      region: { country: 'US', code: 'CO', name: 'Colorado' },
      source: 'osm',
      tiles: 28,
      queued: 28,
      alreadyQueued: 0,
      recentlyDone: 0,
      deferred: 0,
    })
    expect([...store.rows.values()].every(row => row.status === 'pending')).toBe(true)
  })

  /*
   * The acceptance line, held to the letter: asking twice for the same region
   * does not double the shards. The second ask finds every tile queued and
   * writes nothing at all.
   */
  it('is a no-op the second time', async () => {
    const store = memoryStore()
    await reingestRegion('CO', { now: NOW }, store)
    const writesAfterFirst = store.writes
    const rowsAfterFirst = store.rows.size

    const again = await reingestRegion('CO', { now: NOW + 1000 }, store)
    expect(again?.queued).toBe(0)
    expect(again?.alreadyQueued).toBe(28)
    expect(store.rows.size).toBe(rowsAfterFirst)
    expect(store.writes).toBe(writesAfterFirst)
  })

  it('does not undo work the worker finished in between', async () => {
    const store = memoryStore()
    await reingestRegion('CO', { now: NOW }, store)
    // The worker gets through all of it.
    for (const row of store.rows.values()) {
      row.status = 'done'
      row.completed_at = new Date(NOW + HOUR).toISOString()
    }

    const again = await reingestRegion('CO', { now: NOW + 2 * HOUR }, store)
    expect(again?.queued).toBe(0)
    expect(again?.recentlyDone).toBe(28)
    expect([...store.rows.values()].every(row => row.status === 'done')).toBe(true)
  })

  it('gives a parked shard its attempts back', async () => {
    const tile = regionTiles('DE-BE')![0]
    const store = memoryStore([{ shard_key: tile.key, status: 'failed', completed_at: null }])
    store.rows.get(tile.key)!.attempts = 5

    expect((await reingestRegion('DE-BE', { now: NOW }, store))?.queued).toBe(1)
    expect(store.rows.get(tile.key)).toMatchObject({ status: 'pending', attempts: 0 })
  })

  it('never queues more than one request\'s share, whatever it is asked', async () => {
    const store = memoryStore()
    const result = await reingestRegion('AK', { now: NOW, limit: 10_000 }, store)
    expect(result?.queued).toBe(REINGEST_MAX_TILES)
    expect(result!.deferred).toBe(result!.tiles - REINGEST_MAX_TILES)
    expect(store.rows.size).toBe(REINGEST_MAX_TILES)
  })

  it('works through a large region one request at a time', async () => {
    const store = memoryStore()
    const first = await reingestRegion('TX', { now: NOW }, store)
    const second = await reingestRegion('TX', { now: NOW + 1000 }, store)
    const third = await reingestRegion('TX', { now: NOW + 2000 }, store)

    expect(first!.queued + second!.queued).toBe(first!.tiles)
    expect(third?.queued).toBe(0)
    expect(store.rows.size).toBe(first!.tiles)
  })

  it('touches nothing for a region it does not know', async () => {
    const store = memoryStore()
    expect(await reingestRegion('Atlantis', { now: NOW }, store)).toBeNull()
    expect(store.writes).toBe(0)
  })

  it('never reaches the network', async () => {
    const store = memoryStore()
    await reingestRegion('CO', { now: NOW }, store)
    await reingestRegion('DE-BY', { now: NOW }, store)
    expect(fetched).toEqual([])
  })
})

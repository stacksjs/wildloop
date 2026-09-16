/**
 * The process that actually builds the trail database on the server.
 *
 * The site and API services are request-driven; nothing in them would ever run
 * a two-day ingest. This is a third systemd service (see `config/cloud.ts`)
 * whose only job is to work the shard queue forever, so the catalog keeps
 * growing between deploys and re-syncs itself long after the initial pass.
 *
 * It also serves one endpoint on its port. Partly because ts-cloud requires a
 * port for a `start` site, but mostly because a multi-day background job with
 * no way to ask "how far along are you?" is a job nobody trusts — and reading
 * the checkpoint table over ssh is a poor substitute for `curl`.
 */

import process from 'node:process'
import { db } from '@stacksjs/orm'
import { progress, runIngest, seedShards } from './Ingest/ingest'
import { waitForAbortableDelay } from './Ingest/worker-lifecycle'
import { rebuildSearchPlaces } from './Support/searchPlaces'

process.env.APP_ENV ||= 'production'
process.env.NODE_ENV ||= 'production'

const PORT = Number(process.env.PORT ?? 3051)
const HOST = process.env.HOST ?? '127.0.0.1'

/**
 * Pause between batches.
 *
 * The loop only sleeps when there is genuinely nothing claimable — every shard
 * is done and none is old enough to re-sync — so this is the idle heartbeat,
 * not a throttle. Actual politeness to upstream lives in each source's rate
 * limiter, where it belongs.
 */
const IDLE_SLEEP_MS = 5 * 60 * 1000

/**
 * Shards per batch before the loop comes up for air.
 *
 * Bounded so the status endpoint reflects reality within minutes and a restart
 * during a deploy loses at most one shard's work.
 */
const BATCH_SIZE = 25

/**
 * Least time between rebuilds of the home search's place list.
 *
 * The rebuild groups the whole catalog, a second or two on the shared file.
 * It runs only once a batch has written trails and this long has passed, idle
 * or not. Going idle used to skip the wait, and a monthly re-sync writes
 * unchanged rows that still count as written, so a caught-up worker trickling
 * through due shards rebuilt on every five-minute wake. The list can now lag
 * an import by up to an hour plus one idle sleep.
 */
const PLACES_REBUILD_INTERVAL_MS = 60 * 60 * 1000

interface WorkerState {
  startedAt: string
  lastShardAt: string | null
  lastShardKey: string | null
  shardsThisRun: number
  trailsThisRun: number
  failuresThisRun: number
  idle: boolean
}

const state: WorkerState = {
  startedAt: new Date().toISOString(),
  lastShardAt: null,
  lastShardKey: null,
  shardsThisRun: 0,
  trailsThisRun: 0,
  failuresThisRun: 0,
  idle: false,
}

let stopping = false
const stopController = new AbortController()

Bun.serve({
  port: PORT,
  hostname: HOST,

  async fetch(request) {
    const { pathname } = new URL(request.url)

    // A plain liveness probe that touches no database, so it still answers
    // while a long shard is in flight.
    if (pathname === '/health')
      return Response.json({ ok: true, uptimeSeconds: Math.round(process.uptime()) })

    try {
      return Response.json({
        ok: true,
        worker: state,
        sources: await progress(),
      })
    }
    catch (error) {
      return Response.json(
        { ok: false, worker: state, error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      )
    }
  },
})

console.log(`[ingest] status endpoint on http://${HOST}:${PORT}`)

// A deploy sends SIGTERM. Finishing the shard in flight and stopping cleanly
// leaves the checkpoint table consistent; being killed mid-shard leaves a
// `running` row, which the next boot reclaims once it goes stale.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[ingest] ${signal} received, finishing current shard`)
    stopping = true
    stopController.abort()
  })
}

/**
 * Wait for the schema instead of running migrations here.
 *
 * `buddy migrate` runs in the main site's preStart, and ts-cloud gives no
 * ordering guarantee between the three services — this one can boot first, to
 * a database that has no `trail_ingest_shards` yet. Migrating from two
 * processes at once would race on the migrations table, so the worker waits
 * for the site's migration to land rather than competing with it.
 */
async function waitForSchema(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await db.sql`SELECT 1 FROM trail_ingest_shards LIMIT 1`.execute()
      return
    }
    catch {
      if (attempt === 0)
        console.log('[ingest] waiting for migrations to create trail_ingest_shards…')
      await Bun.sleep(10_000)
    }
  }

  throw new Error('trail_ingest_shards never appeared; is `buddy migrate` running on deploy?')
}

await waitForSchema()

const seeded = await seedShards()
console.log(`[ingest] ${seeded} shards known`)

// Built once before the first batch. A batch can run for a long time, and a
// catalog that is already fully synced may not change a trail for weeks, so
// waiting for either would leave a freshly deployed place list empty. If this
// attempt fails, the flag stays set and the loop retries.
let placesDirty = !(await rebuildSearchPlaces())
let placesRebuiltAt = placesDirty ? 0 : Date.now()

while (!stopping) {
  const outcomes = await runIngest({
    maxShards: BATCH_SIZE,
    shouldStop: () => stopping,
    onShard: (outcome) => {
      state.lastShardAt = new Date().toISOString()
      state.lastShardKey = outcome.key
      state.shardsThisRun++
      state.trailsThisRun += outcome.imported + outcome.updated

      console.log(
        `[ingest] ${outcome.key} ${outcome.seen} features → `
        + `+${outcome.imported} new, ~${outcome.updated} updated (${(outcome.durationMs / 1000).toFixed(1)}s)`,
      )
    },
    onError: (key, error) => {
      state.failuresThisRun++
      console.error(`[ingest] ${key} failed: ${error instanceof Error ? error.message : String(error)}`)
    },
  })

  if (stopping)
    break

  // Nothing claimable: every shard is done and none is due for re-sync yet.
  state.idle = outcomes.length === 0

  if (outcomes.some(outcome => outcome.imported + outcome.updated > 0))
    placesDirty = true

  if (placesDirty && Date.now() - placesRebuiltAt >= PLACES_REBUILD_INTERVAL_MS) {
    if (await rebuildSearchPlaces()) {
      placesDirty = false
      placesRebuiltAt = Date.now()
    }
  }

  if (state.idle) {
    console.log(`[ingest] nothing to claim, sleeping ${IDLE_SLEEP_MS / 60000}m`)
    await waitForAbortableDelay(IDLE_SLEEP_MS, stopController.signal)
  }
}

console.log('[ingest] stopped')
process.exit(0)

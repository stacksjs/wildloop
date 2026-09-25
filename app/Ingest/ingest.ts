/**
 * The ingest engine: turns the source adapters into a national trail database
 * that keeps building itself.
 *
 * The unit of work is a shard (see `TrailIngestShard`), and the loop is
 * deliberately boring — claim the oldest pending shard, fetch it, upsert what
 * it returned, record the outcome, repeat. Everything interesting is in what
 * that boringness buys:
 *
 *  - **Resumability.** Progress is in the database, not in memory, so a deploy
 *    or a crash costs one shard rather than the whole run.
 *  - **Idempotency.** Writes go through a single upsert keyed on
 *    `(source, source_id)`, so re-running a shard refreshes rows instead of
 *    duplicating them. That is what makes a permanent re-sync cycle safe.
 *  - **Isolation.** One source failing (Overpass goes down for a day) does not
 *    stop the others; its shards simply fail, back off and get retried.
 */

import type { NormalizedTrail, TrailSource } from './types'
import { db } from '@stacksjs/orm'
import { getSource, sources } from './sources'
import { inWriteTransaction } from '../Support/writeTransaction'

/** Rows per upsert statement. Large enough to amortise, small enough for SQLite's parameter cap. */
const WRITE_BATCH = 200

/** A shard that has failed this many times is parked rather than retried forever. */
const MAX_ATTEMPTS = 5

/**
 * How long a `running` shard may sit before it is assumed dead and reclaimed.
 *
 * Longer than the slowest legitimate shard: a dense Overpass tile can take
 * five minutes, and the retry ladder inside the HTTP client can stretch that
 * to twenty before it gives up.
 */
const STALE_RUNNING_MS = 45 * 60 * 1000

/**
 * A completed shard becomes eligible again after this long, which is what
 * turns a one-off import into a catalog that tracks upstream. Trails change
 * slowly; a month is frequent enough to catch reroutes and closures without
 * spending the whole year re-fetching.
 */
const RESYNC_AFTER_MS = 30 * 24 * 3600 * 1000

/** Columns refreshed when a trail already exists. */
const MERGE_COLUMNS = [
  'name',
  'location',
  'description',
  'distance',
  'elevation',
  'elevation_high',
  'difficulty',
  'route_type',
  'surface',
  'estimated_time',
  'geometry',
  'latitude',
  'longitude',
  'min_lat',
  'max_lat',
  'min_lng',
  'max_lng',
  'country',
  'state',
  'state_name',
  'managed_by',
  'allowed_uses',
  'dogs_allowed',
  'wheelchair_accessible',
  'national_trail',
  'source_url',
  'synced_at',
  'updated_at',
  // Deliberately NOT merged: `image`, `tags`, `rating`, `review_count`. The
  // first two are presentation the app may later curate, and the ratings are
  // ours — they come from Wildloop users, not from upstream, and a re-sync
  // must never wipe them.
]

export interface ShardOutcome {
  key: string
  source: TrailSource
  seen: number
  imported: number
  updated: number
  durationMs: number
}

export interface IngestProgress {
  source: TrailSource
  pending: number
  running: number
  done: number
  failed: number
  total: number
  trails: number
}

/**
 * Ensure every shard of every source exists as a row.
 *
 * Safe to call on every boot: shard enumeration is deterministic, and the
 * insert ignores keys that are already there. New shards (a new park unit, a
 * new forest) therefore appear automatically without a migration.
 */
export async function seedShards(only?: TrailSource[]): Promise<number> {
  const wanted = only?.length ? sources.filter(source => only.includes(source.source)) : sources
  let created = 0

  for (const adapter of wanted) {
    const shards = await adapter.shards()
    const now = new Date().toISOString()

    for (let i = 0; i < shards.length; i += WRITE_BATCH) {
      const batch = shards.slice(i, i + WRITE_BATCH).map(shard => ({
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
      }))

      // `insertOrIgnore` rather than `upsert`: an existing shard carries
      // progress, and re-seeding must never reset it back to pending.
      await db.insertOrIgnore('trail_ingest_shards', batch)
    }

    created += shards.length
  }

  return created
}

/**
 * Put finished shards back at the front of the queue, ahead of their monthly
 * re-sync, so the worker re-fetches them next.
 *
 * For when the ingest's own processing changed and rows already written are
 * wrong — not stale upstream data, which the re-sync cycle handles on its own.
 * Only shards completed before `completedBefore` are touched, which makes this
 * idempotent: once a shard has been redone its completion time is newer, and
 * running the same requeue again leaves it alone. Returns the shards requeued
 * (or, with `dryRun`, that would be).
 */
export async function requeueShards(only: TrailSource[], completedBefore: string, dryRun = false): Promise<number> {
  if (only.length === 0)
    return 0
  const inList = only.map(source => `'${source.replace(/'/g, '')}'`).join(',')

  const [row] = await db.sql`
    SELECT COUNT(*) AS count
    FROM trail_ingest_shards
    WHERE source IN (${db.unsafe(inList)})
      AND status = 'done'
      AND (completed_at IS NULL OR completed_at < ${completedBefore})
  `.execute() as Array<{ count: number }>
  const count = Number(row?.count ?? 0)

  if (!dryRun && count > 0) {
    await db.sql`
      UPDATE trail_ingest_shards
      SET status = 'pending', updated_at = ${new Date().toISOString()}
      WHERE source IN (${db.unsafe(inList)})
        AND status = 'done'
        AND (completed_at IS NULL OR completed_at < ${completedBefore})
    `.execute()
  }

  return count
}

interface ShardRow {
  id: number
  shard_key: string
  source: TrailSource
  cursor: string
  attempts: number
}

/**
 * Claim the next shard to work on, marking it `running` so a second worker
 * does not pick up the same one.
 *
 * Order of preference:
 *  1. shards that have never run,
 *  2. shards whose `running` claim has gone stale (a worker died),
 *  3. shards that failed and have attempts left,
 *  4. shards finished long enough ago to be worth re-syncing.
 *
 * The claim is a conditional UPDATE — it only succeeds if the row is still in
 * the state we read it in, so two workers racing on the same row cannot both
 * win.
 */
export async function claimShard(only?: TrailSource[]): Promise<ShardRow | null> {
  const now = Date.now()
  const staleBefore = new Date(now - STALE_RUNNING_MS).toISOString()
  const resyncBefore = new Date(now - RESYNC_AFTER_MS).toISOString()
  const sourceFilter = only?.length ? only : sources.map(source => source.source)

  // Stale claims come FIRST, ahead of untouched work.
  //
  // They used to sit behind `pending`, and since the pending queue is
  // continuously replenished by re-seeding, a shard orphaned by a killed
  // worker was only reclaimed once every other shard was done. One sat in
  // `running` for 21 hours — counted as neither pending nor failed, and
  // showing in the progress readout as though a worker were on it, which is
  // exactly the state that hides a problem instead of surfacing it.
  //
  // `attempts` is what makes this safe to prioritise: a shard that kills its
  // worker gets reclaimed, charged an attempt, and eventually stops being
  // retried rather than looping ahead of real progress forever.
  const candidates = [
    { status: 'running', where: `status = 'running' AND attempts < ${MAX_ATTEMPTS} AND (started_at IS NULL OR started_at < '${staleBefore}')`, chargeAttempt: true },
    { status: 'pending', where: 'status = \'pending\'' },
    { status: 'failed', where: `status = 'failed' AND attempts < ${MAX_ATTEMPTS}` },
    { status: 'done', where: `status = 'done' AND (completed_at IS NULL OR completed_at < '${resyncBefore}')` },
  ]

  const inList = sourceFilter.map(source => `'${source}'`).join(',')

  for (const candidate of candidates) {
    const rows = await db.sql`
      SELECT id, shard_key, source, cursor, attempts, status
      FROM trail_ingest_shards
      WHERE source IN (${db.unsafe(inList)}) AND (${db.unsafe(candidate.where)})
      ORDER BY id ASC
      LIMIT 1
    `.execute() as Array<ShardRow & { status: string }>

    const row = rows?.[0]
    if (!row)
      continue

    // Reclaiming an orphan charges an attempt; a first claim does not. Without
    // it a shard that kills its worker would be reclaimed forever at the front
    // of the queue, never reaching MAX_ATTEMPTS because nothing survives long
    // enough to record the failure.
    const attemptBump = candidate.chargeAttempt ? db.unsafe(', attempts = attempts + 1') : db.unsafe('')

    const claimed = await db.sql`
      UPDATE trail_ingest_shards
      SET status = 'running', started_at = ${new Date().toISOString()}, updated_at = ${new Date().toISOString()}${attemptBump}
      WHERE id = ${row.id} AND status = ${row.status}
    `.execute()

    // Another worker won the race; fall through and look again.
    if (rowsAffected(claimed) === 0)
      continue

    return row
  }

  return null
}

/**
 * Drivers report affected rows differently (a number, a `{changes}` object, an
 * array). Anything we cannot read is treated as "claimed", because failing to
 * claim a shard we did claim would strand it in `running` until it went stale.
 */
function rowsAffected(result: unknown): number {
  if (typeof result === 'number')
    return result
  if (Array.isArray(result))
    return result.length || 1
  if (result && typeof result === 'object') {
    const record = result as Record<string, unknown>
    for (const key of ['changes', 'affectedRows', 'rowsAffected', 'count']) {
      if (typeof record[key] === 'number')
        return record[key] as number
    }
  }
  return 1
}

/** Fetch one shard, write what it returned, and record the outcome. */
export async function runShard(row: ShardRow): Promise<ShardOutcome> {
  const started = Date.now()
  const adapter = getSource(row.source)

  try {
    const result = await adapter.fetch({
      source: row.source,
      key: row.shard_key,
      cursor: JSON.parse(row.cursor || '{}'),
    })

    const { imported, updated } = await writeTrails(result.trails)
    const completedAt = new Date().toISOString()

    await db.sql`
      UPDATE trail_ingest_shards
      SET status = 'done',
          features_seen = ${result.seen},
          trails_imported = ${imported},
          trails_updated = ${updated},
          last_error = '',
          completed_at = ${completedAt},
          updated_at = ${completedAt}
      WHERE id = ${row.id}
    `.execute()

    return {
      key: row.shard_key,
      source: row.source,
      seen: result.seen,
      imported,
      updated,
      durationMs: Date.now() - started,
    }
  }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const now = new Date().toISOString()

    await db.sql`
      UPDATE trail_ingest_shards
      SET status = 'failed',
          attempts = attempts + 1,
          last_error = ${message.slice(0, 1000)},
          updated_at = ${now}
      WHERE id = ${row.id}
    `.execute()

    throw error
  }
}

/**
 * Upsert a shard's trails, and report how many were new.
 *
 * The "new vs updated" split needs a read: an upsert cannot say which branch
 * it took. One indexed `IN` query per batch against the unique
 * `(source, source_id)` index is cheap next to the network round trip that
 * produced the rows, and the numbers are what make the progress readout mean
 * anything.
 */
export async function writeTrails(trails: NormalizedTrail[]): Promise<{ imported: number, updated: number }> {
  if (trails.length === 0)
    return { imported: 0, updated: 0 }

  let imported = 0
  let updated = 0

  for (let i = 0; i < trails.length; i += WRITE_BATCH) {
    const batch = trails.slice(i, i + WRITE_BATCH)
    const now = new Date().toISOString()

    const ids = batch.map(trail => `'${trail.sourceId.replace(/'/g, '\'\'')}'`).join(',')

    // Read, retract, upsert and re-add as one transaction. Apart, an FTS
    // 'rebuild' from another process (TrailSeeder does one) could commit
    // between the retract and the re-add: it re-indexes the old terms the
    // retract had just removed, the re-add then indexes the new ones, and the
    // index is left holding terms its content no longer has.
    const existing = await inWriteTransaction(async () => {
      // Read the FTS columns as well as the key: the search index has to be
      // retracted using the values as they are NOW, before the upsert replaces
      // them. Reading them afterwards would retract the new terms and leave the
      // old ones matching forever.
      const existingRows = await db.sql`
        SELECT id, source_id, name, location, state_name FROM trails
        WHERE source = ${batch[0].source} AND source_id IN (${db.unsafe(ids)})
      `.execute() as Array<{ id: number, source_id: string, name: string, location: string, state_name: string }>

      const seen = new Set((existingRows ?? []).map(row => row.source_id))

      await retractFromSearchIndex(existingRows ?? [])

      const rows = batch.map(trail => ({
        uuid: crypto.randomUUID(),
        source: trail.source,
        source_id: trail.sourceId,
        source_url: trail.sourceUrl,
        synced_at: now,

        name: trail.name,
        location: trail.location,
        description: trail.description,

        latitude: trail.latitude,
        longitude: trail.longitude,
        min_lat: trail.minLat,
        max_lat: trail.maxLat,
        min_lng: trail.minLng,
        max_lng: trail.maxLng,
        country: trail.country,
        state: trail.state,
        state_name: trail.stateName,
        managed_by: trail.managedBy,

        distance: trail.distance,
        elevation: trail.elevation,
        elevation_high: trail.elevationHigh,
        difficulty: trail.difficulty,
        route_type: trail.routeType,
        surface: trail.surface,
        estimated_time: trail.estimatedTime,
        geometry: trail.geometry,

        allowed_uses: trail.allowedUses,
        dogs_allowed: trail.dogsAllowed,
        wheelchair_accessible: trail.wheelchairAccessible,
        national_trail: trail.nationalTrail,

        image: trail.image,
        tags: trail.tags,
        rating: 0,
        review_count: 0,

        created_at: now,
        updated_at: now,
      }))

      await db.upsert('trails', rows, ['source', 'source_id'], MERGE_COLUMNS)
      await addToSearchIndex(batch[0].source, batch.map(trail => trail.sourceId))

      return seen
    })

    for (const trail of batch) {
      if (existing.has(trail.sourceId))
        updated++
      else
        imported++
    }
  }

  return { imported, updated }
}

/**
 * Keep `trails_fts` in step with the rows this function writes.
 *
 * External-content FTS5 does not observe writes to its content table, so an
 * upsert that renames a trail leaves the index still matching the old name.
 *
 * The natural place for this is a trigger, and it is not one because the
 * migration runner cannot create triggers: it splits a `.sql` file on every
 * `;` outside quotes with no knowledge of `BEGIN ... END`, so a trigger body
 * reaches SQLite in fragments (see 0000000079-create-trails-fts.sql).
 *
 * Doing it here is sound because this is the only path that writes trails in
 * volume. A row edited some other way stays stale until its shard re-syncs,
 * the same 30-day bound everything else has.
 *
 * Failures are logged rather than thrown: a search index briefly behind is a
 * far better outcome than an ingest that stops.
 */
interface SearchIndexRow {
  id: number
  name: string
  location: string
  state_name: string
}

/**
 * Retract rows from the index. MUST run before the upsert overwrites them —
 * FTS5 cannot recover the old terms itself, so it is handed the values that
 * are still in the table at this point.
 */
async function retractFromSearchIndex(rows: SearchIndexRow[]): Promise<void> {
  if (rows.length === 0)
    return

  try {
    for (const row of rows) {
      await db.sql`
        INSERT INTO trails_fts(trails_fts, rowid, name, location, state_name)
        VALUES ('delete', ${row.id}, ${row.name}, ${row.location}, ${row.state_name})
      `.execute()
    }
  }
  catch (error) {
    console.warn(`[ingest] search index retract failed: ${error instanceof Error ? error.message : error}`)
  }
}

/** Add the current state of these rows to the index, after the upsert. */
async function addToSearchIndex(source: string, sourceIds: string[]): Promise<void> {
  if (sourceIds.length === 0)
    return

  const quoted = sourceIds.map(id => `'${id.replace(/'/g, '\'\'')}'`).join(',')

  try {
    await db.sql`
      INSERT INTO trails_fts(rowid, name, location, state_name)
      SELECT id, name, location, state_name FROM trails
      WHERE source = ${source} AND source_id IN (${db.unsafe(quoted)})
    `.execute()
  }
  catch (error) {
    console.warn(`[ingest] search index add failed: ${error instanceof Error ? error.message : error}`)
  }
}

/** Per-source counts, for the CLI and the worker's status endpoint. */
export async function progress(): Promise<IngestProgress[]> {
  const shardRows = await db.sql`
    SELECT source, status, COUNT(*) AS count
    FROM trail_ingest_shards
    GROUP BY source, status
  `.execute() as Array<{ source: TrailSource, status: string, count: number }>

  const trailRows = await db.sql`
    SELECT source, COUNT(*) AS count FROM trails GROUP BY source
  `.execute() as Array<{ source: string, count: number }>

  const trailCounts = new Map(trailRows?.map(row => [row.source, Number(row.count)]))

  return sources.map((adapter) => {
    const rows = (shardRows ?? []).filter(row => row.source === adapter.source)
    const byStatus = (status: string) => Number(rows.find(row => row.status === status)?.count ?? 0)

    const pending = byStatus('pending')
    const running = byStatus('running')
    const done = byStatus('done')
    const failed = byStatus('failed')

    return {
      source: adapter.source,
      pending,
      running,
      done,
      failed,
      total: pending + running + done + failed,
      trails: trailCounts.get(adapter.source) ?? 0,
    }
  })
}

export interface IngestRunOptions {
  /** Restrict the run to these sources. Defaults to all of them. */
  only?: TrailSource[]
  /** Stop after this many shards. 0 runs until nothing is claimable. */
  maxShards?: number
  /** Called after each shard, for CLI output. */
  onShard?: (outcome: ShardOutcome) => void
  /** Called when a shard fails, so a long run can report without stopping. */
  onError?: (key: string, error: unknown) => void
  /**
   * Checked before every shard. The worker uses this to honour SIGTERM
   * promptly — without it, a deploy would wait out the rest of the batch,
   * which on Overpass is a quarter of an hour, and get SIGKILLed instead.
   */
  shouldStop?: () => boolean
}

/**
 * Work shards until the budget runs out or nothing is claimable.
 *
 * A failing shard is reported and skipped rather than thrown: over a run of a
 * thousand shards, some upstream request will fail, and stopping the country's
 * ingest because one Overpass tile timed out would be the wrong trade.
 */
export async function runIngest(options: IngestRunOptions = {}): Promise<ShardOutcome[]> {
  const outcomes: ShardOutcome[] = []
  const budget = options.maxShards ?? 0

  while (budget === 0 || outcomes.length < budget) {
    if (options.shouldStop?.())
      break

    const shard = await claimShard(options.only)
    if (!shard)
      break

    try {
      const outcome = await runShard(shard)
      outcomes.push(outcome)
      options.onShard?.(outcome)
    }
    catch (error) {
      options.onError?.(shard.shard_key, error)
    }
  }

  return outcomes
}

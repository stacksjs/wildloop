import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { db } from '@stacksjs/orm'
import { ExitCode } from '@stacksjs/types'
import { writeTrails } from '../Ingest/ingest'
import { fetchRelationsByIds } from '../Ingest/sources/osm'

interface RepairOptions {
  batch?: number | string
  limit?: number | string
  dryRun?: boolean
  syncedBefore?: string
}

/**
 * How many relation ids go into one Overpass request.
 *
 * Overpass answers a 150-id batch comfortably inside its timeout; larger
 * batches start returning partial results for long routes, which would look
 * like a successful repair that quietly dropped members.
 */
const DEFAULT_BATCH = 150

/**
 * `buddy trails:repair-distances` — recompute OSM relation lengths.
 *
 * Relations ingested before member boundaries were preserved had their length
 * measured across the gaps between member ways, which counted the jump from
 * the end of one member to the start of the next as trail. It put the North
 * Country Trail at 2,647 miles and Zentralalpenweg 02, a ~1,300 km route, at
 * 1,687.
 *
 * The stored geometry is flattened, so the true length cannot be recovered
 * from the database — the members have to come back from Overpass. Fetching
 * the affected relations by id costs ~95 requests against the 1,459 tiles a
 * full re-sync would need, and leaves the 230,000 ways (which were never
 * wrong) untouched.
 *
 * The same re-fetch rebuilds each relation's line: members used to be drawn
 * end to end in relation order, with a straight line across every gap and
 * back from every spur. They are now assembled by shared endpoints into
 * walkable parts (see resources/functions/trail-geometry.ts).
 *
 * Resumable: `writeTrails` stamps `synced_at`, and this only selects relations
 * stamped before the cutoff — the start of the run, or `--synced-before`. Pass
 * the same `--synced-before` to every run of one repair and an interrupted
 * repair continues where it stopped, and a completed one is a no-op.
 */
export default function (cli: CLI) {
  cli
    .command('trails:repair-distances', 'Re-fetch OSM relations: distances and lines built across member gaps')
    .option('--batch [count]', 'Relation ids per Overpass request', { default: DEFAULT_BATCH })
    .option('--limit [count]', 'Stop after this many relations (0 = all)', { default: 0 })
    .option('--dry-run', 'Report what would change without writing', { default: false })
    .option('--synced-before <iso>', 'Only relations last synced before this ISO time (default: the start of this run)')
    .action(async (options: RepairOptions) => {
      intro('trails:repair-distances')

      const batchSize = Math.max(1, Number(options.batch ?? DEFAULT_BATCH) || DEFAULT_BATCH)
      const limit = Math.max(0, Number(options.limit ?? 0) || 0)

      // Anything already re-synced is correct by definition, so the cutoff is
      // taken before the first fetch rather than per batch.
      const cutoffDate = options.syncedBefore ? new Date(options.syncedBefore) : new Date()
      if (Number.isNaN(cutoffDate.getTime())) {
        log.error(`--synced-before is not a date: ${options.syncedBefore}`)
        process.exitCode = ExitCode.FatalError
        return
      }
      const cutoff = cutoffDate.toISOString()

      const rows = await db.sql`
        SELECT source_id, distance
        FROM trails
        WHERE source = 'osm'
          AND source_id LIKE 'relation/%'
          AND (synced_at IS NULL OR synced_at < ${cutoff})
        ORDER BY distance DESC
      `.execute() as Array<{ source_id: string, distance: number }>

      const pending = (rows ?? [])
        .map(row => ({ id: Number(row.source_id.replace('relation/', '')), before: Number(row.distance) }))
        .filter(row => Number.isFinite(row.id))

      const targets = limit > 0 ? pending.slice(0, limit) : pending

      if (targets.length === 0) {
        log.success('Nothing to repair — every relation has been re-synced.')
        outro('Done')
        return
      }

      const batches = Math.ceil(targets.length / batchSize)
      log.info(`${targets.length.toLocaleString()} relations in ${batches} request(s) of up to ${batchSize}`)

      if (options.dryRun)
        log.warn('Dry run: fetching and comparing, but not writing.')

      const before = new Map(targets.map(row => [row.id, row.before]))

      let fetched = 0
      let written = 0
      let shrunk = 0
      let totalMilesRemoved = 0
      let failures = 0

      for (let i = 0; i < targets.length; i += batchSize) {
        const ids = targets.slice(i, i + batchSize).map(row => row.id)
        const batchNumber = Math.floor(i / batchSize) + 1

        try {
          const { trails } = await fetchRelationsByIds(ids)
          fetched += trails.length

          for (const trail of trails) {
            const id = Number(trail.sourceId.replace('relation/', ''))
            const was = before.get(id)
            if (was !== undefined && trail.distance < was) {
              shrunk++
              totalMilesRemoved += was - trail.distance
            }
          }

          if (!options.dryRun) {
            const result = await writeTrails(trails)
            written += result.imported + result.updated
          }

          log.info(`  batch ${batchNumber}/${batches}: ${trails.length} relations${options.dryRun ? '' : ' written'}`)
        }
        catch (error) {
          // One bad batch must not end the run: the rest are independent, and
          // a re-run picks up whatever this batch left behind.
          failures++
          log.warn(`  batch ${batchNumber}/${batches} failed: ${error instanceof Error ? error.message : error}`)
        }
      }

      log.info('')
      log.info(`fetched   ${fetched.toLocaleString()}`)
      log.info(`written   ${written.toLocaleString()}`)
      log.info(`corrected ${shrunk.toLocaleString()} (${Math.round(totalMilesRemoved).toLocaleString()} phantom miles removed)`)

      if (failures > 0) {
        log.warn(`${failures} batch(es) failed — re-run to pick them up.`)
        process.exitCode = ExitCode.FatalError
        return
      }

      outro('Done')
    })
}

import type { TrailSource } from '../Ingest/types'
import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { requeueShards } from '../Ingest/ingest'
import { sourceNames } from '../Ingest/sources'

interface RequeueOptions {
  source?: string
  before?: string
  dryRun?: boolean
}

/**
 * The sources whose multi-segment trails were stitched into one line with
 * straight hops between the pieces (see resources/functions/trail-geometry.ts)
 * until the geometry was rebuilt as a network. Every one of their shards
 * carries such trails, so all of them are redone. OSM ways were always single
 * lines; its relations are repaired by id with `trails:repair-distances`
 * instead of re-running 1,459 Overpass tiles.
 */
const DEFAULT_SOURCES: TrailSource[] = ['nps', 'usfs']

/**
 * `buddy trails:requeue` — re-fetch shards whose rows the current ingest would
 * write differently.
 *
 * Marks finished shards `pending`; the ingest worker claims pending work before
 * anything else, so it re-fetches them on its next batch and the upsert
 * rewrites each trail in place (same `source_id`, so reviews, saves and
 * records stay attached). Or run `buddy trails:ingest --source nps,usfs
 * --shards 0` to work through them directly.
 *
 * Idempotent: only shards completed before `--before` are touched, and a
 * redone shard's completion time is after it.
 */
export default function (cli: CLI) {
  cli
    .command('trails:requeue', 'Queue finished ingest shards to be fetched again')
    .option('--source <source>', `Sources to requeue (default ${DEFAULT_SOURCES.join(',')}): ${sourceNames().join(', ')}`)
    .option('--before <iso>', 'Only shards completed before this ISO time (default: now)')
    .option('--dry-run', 'Count the shards without requeueing them', { default: false })
    .action(async (options: RequeueOptions) => {
      intro('trails:requeue')

      const requested = (options.source ?? DEFAULT_SOURCES.join(','))
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
      const known = sourceNames()
      const unknown = requested.filter(value => !known.includes(value as TrailSource))
      if (unknown.length > 0) {
        log.error(`Unknown source(s) ${unknown.join(', ')}. Available: ${known.join(', ')}`)
        process.exitCode = ExitCode.FatalError
        return
      }

      const before = options.before ? new Date(options.before) : new Date()
      if (Number.isNaN(before.getTime())) {
        log.error(`--before is not a date: ${options.before}`)
        process.exitCode = ExitCode.FatalError
        return
      }

      const count = await requeueShards(requested as TrailSource[], before.toISOString(), Boolean(options.dryRun))

      log.info(`${options.dryRun ? 'Would requeue' : 'Requeued'} ${count.toLocaleString()} shard(s) of ${requested.join(', ')} completed before ${before.toISOString()}`)
      if (!options.dryRun && count > 0)
        log.info(`The ingest worker picks them up next, or run: buddy trails:ingest --source ${requested.join(',')} --shards 0`)

      // exitCode, not exit(): exiting straight away dropped the log lines above
      // before they were written, so the command printed nothing at all.
      outro('Done')
      process.exitCode = ExitCode.Success
    })
}

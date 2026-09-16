import type { TrailSource } from '../Ingest/types'
import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { progress, runIngest, seedShards } from '../Ingest/ingest'
import { rebuildSearchPlaces } from '../Support/searchPlaces'
import { sourceNames } from '../Ingest/sources'

interface IngestOptions {
  source?: string
  shards?: number | string
  seedOnly?: boolean
  report?: boolean
  verbose?: boolean
}

/**
 * `buddy trails:ingest` — build (and keep building) the US trail catalog.
 *
 * The same entry point serves three jobs, because they are the same job at
 * different scales: seed the work list, run some of it, or just report. The
 * production worker calls the identical functions, so what you see locally is
 * exactly what runs on the server.
 */
export default function (cli: CLI) {
  cli
    .command('trails:ingest', 'Ingest US trails from OpenStreetMap, the Forest Service and the Park Service')
    .option('--source <source>', `Restrict to one source: ${sourceNames().join(', ')}`)
    .option('--shards [count]', 'Stop after this many shards (0 = run until nothing is claimable)', { default: 10 })
    .option('--seed-only', 'Enumerate shards and exit without fetching', { default: false })
    // `--report`, not `--status`: buddy already has a top-level `status`
    // command, and the flag is swallowed before this command ever sees it.
    .option('--report', 'Print progress and exit', { default: false })
    .option('--verbose', 'Log every shard as it completes', { default: true })
    .alias('ingest:trails')
    .action(async (options: IngestOptions) => {
      const perf = await intro('buddy trails:ingest')

      const only = resolveSources(options.source)
      if (only === null) {
        log.error(`Unknown source "${options.source}". Available: ${sourceNames().join(', ')}`)
        process.exit(ExitCode.FatalError)
      }

      if (options.report) {
        await printProgress()
        await outro('Trail ingest status', { startTime: perf, useSeconds: true })
        process.exit(ExitCode.Success)
      }

      log.info(`Enumerating shards for ${only?.join(', ') ?? 'all sources'}…`)
      const total = await seedShards(only)
      log.info(`${total} shards known`)

      if (options.seedOnly) {
        await printProgress()
        await outro('Shards seeded', { startTime: perf, useSeconds: true })
        process.exit(ExitCode.Success)
      }

      const maxShards = Number(options.shards ?? 10) || 0
      log.info(maxShards === 0 ? 'Running until no shard is claimable' : `Running up to ${maxShards} shards`)

      let imported = 0
      let updated = 0
      let failures = 0

      const outcomes = await runIngest({
        only,
        maxShards,
        onShard: (outcome) => {
          imported += outcome.imported
          updated += outcome.updated

          if (options.verbose) {
            log.info(
              `  ${outcome.key.padEnd(18)} ${String(outcome.seen).padStart(6)} features → `
              + `+${outcome.imported} new, ~${outcome.updated} updated (${(outcome.durationMs / 1000).toFixed(1)}s)`,
            )
          }
        },
        onError: (key, error) => {
          failures++
          log.warn(`  ${key} failed: ${error instanceof Error ? error.message : String(error)}`)
        },
      })

      // The home search suggests places from the trails, so a run that changed
      // any trail refreshes that list before reporting.
      if (imported + updated > 0)
        await rebuildSearchPlaces()

      console.log('')
      log.info('--- Summary ---')
      log.info(`  Shards completed: ${outcomes.length}`)
      log.info(`  Trails imported:  ${imported}`)
      log.info(`  Trails updated:   ${updated}`)
      if (failures > 0)
        log.warn(`  Shards failed:    ${failures} (they stay claimable and will be retried)`)

      console.log('')
      await printProgress()

      await outro(`Ingested ${imported + updated} trails`, { startTime: perf, useSeconds: true })
      process.exit(ExitCode.Success)
    })

  cli.on('trails:ingest:*', () => {
    log.error('Invalid command: %s\nSee --help for a list of available commands.', cli.args.join(' '))
    process.exit(1)
  })
}

function resolveSources(source?: string): TrailSource[] | undefined | null {
  if (!source)
    return undefined

  const requested = source.split(',').map(value => value.trim()).filter(Boolean)
  const known = sourceNames()

  if (requested.some(value => !known.includes(value as TrailSource)))
    return null

  return requested as TrailSource[]
}

/**
 * The progress table goes to stdout via `console.log`, not through `log.info`.
 *
 * Two reasons. It is a report — unprefixed and pipeable is what you want when
 * you are grepping it or watching it over ssh. And the framework logger writes
 * asynchronously, so a `--report` run (which does nothing but this table and
 * then exits) loses every line to `process.exit` before the transport
 * flushes — the command printed absolutely nothing.
 */
async function printProgress(): Promise<void> {
  const rows = await progress()

  console.log('')
  console.log('  source     shards    done   queued   failed     trails')
  console.log('  ────────────────────────────────────────────────────────')

  for (const row of rows) {
    console.log(
      `  ${row.source.padEnd(8)} ${String(row.total).padStart(8)} ${String(row.done).padStart(7)} `
      + `${String(row.pending + row.running).padStart(8)} ${String(row.failed).padStart(8)} `
      + `${row.trails.toLocaleString('en-US').padStart(10)}`,
    )
  }

  const totalTrails = rows.reduce((sum, row) => sum + row.trails, 0)
  const totalDone = rows.reduce((sum, row) => sum + row.done, 0)
  const totalShards = rows.reduce((sum, row) => sum + row.total, 0)

  console.log('  ────────────────────────────────────────────────────────')
  console.log(
    `  ${'total'.padEnd(8)} ${String(totalShards).padStart(8)} ${String(totalDone).padStart(7)} `
    + `${''.padStart(8)} ${''.padStart(8)} ${totalTrails.toLocaleString('en-US').padStart(10)}`,
  )
  console.log('')
}

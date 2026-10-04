import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { repairCounters } from '../Support/counterRepair'

/**
 * `buddy counters:recompute` - rebuild every denormalized counter from its
 * source-of-truth rows (#973): activities.kudos_count from kudos,
 * trails.rating/review_count from trail reviews, and each player's territory
 * holdings from the territories they hold. Rows for players who no longer
 * exist are removed.
 *
 * Write paths keep these in sync per-row; this command is the 04:10 drift
 * repair and the on-demand CLI entry point. The work is shared with
 * RecomputeCountersAction via app/Support/counterRepair.ts.
 */
export default function (cli: CLI) {
  cli
    .command('counters:recompute', 'Recompute denormalized counters (kudos, trail ratings, territory holdings)')
    .option('--dry-run', 'Preview without writing to database', { default: false })
    .alias('recompute:counters')
    .action(async (options: { dryRun: boolean }) => {
      const perf = await intro('buddy counters:recompute')

      const report = await repairCounters({ dryRun: options.dryRun, log: line => console.log(line) })
      const changed = report.activitiesFixed + report.trailsFixed + report.territoryStatsFixed
        + report.territoryStatsRemoved + report.territoryStatsCreated + report.segmentsFixed

      if (changed === 0) {
        log.info(`All counters already in sync (${report.activitiesTotal} activities, ${report.trailsTotal} rated trails).`)
        await outro('Done', { startTime: perf, useSeconds: true })
        process.exit(ExitCode.Success)
      }

      await outro(
        `Fixed ${report.activitiesFixed} activity, ${report.trailsFixed} trail and ${report.territoryStatsFixed} territory counter(s); `
        + `removed ${report.territoryStatsRemoved} and created ${report.territoryStatsCreated} territory stats row(s); `
        + `fixed the climb on ${report.segmentsFixed} segment(s)`
        + `${options.dryRun ? ' (dry run - nothing written)' : ''}`,
        { startTime: perf, useSeconds: true },
      )
      process.exit(ExitCode.Success)
    })
}

import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { KEPT_VIEW_DAYS, pruneTrailViews } from '../Support/trailViews'

/**
 * `buddy trails:prune-views` - forget trail page views older than anything
 * looks at (app/Support/trailViews.ts). Ranking reads 30 days; 120 are kept.
 *
 * The 04:40 job. Removes at most `--max-batches` × `--batch` rows a night,
 * so a backlog is worked off over several nights rather than holding the
 * write lock for one long delete.
 */
export default function (cli: CLI) {
  cli
    .command('trails:prune-views', 'Remove trail page view counts older than the retention window')
    .option('--days [days]', 'Days of views to keep', { default: KEPT_VIEW_DAYS })
    .option('--batch [rows]', 'Rows removed per delete', { default: 5000 })
    .option('--max-batches [n]', 'Deletes per run', { default: 50 })
    .action(async (options: { days: number, batch: number, maxBatches: number }) => {
      const perf = await intro('buddy trails:prune-views')

      const report = await pruneTrailViews({
        keepDays: Number(options.days) || KEPT_VIEW_DAYS,
        batch: Math.max(1, Number(options.batch) || 5000),
        maxBatches: Math.max(1, Number(options.maxBatches) || 50),
      })

      if (report.more)
        log.info('Stopped at the batch limit with older days left; the next run continues.')

      await outro(`Removed ${report.removed} trail view day(s)`, { startTime: perf, useSeconds: true })
      process.exit(ExitCode.Success)
    })
}

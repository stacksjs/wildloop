import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { snapshotDatabase } from '../Support/databaseSnapshot'

/**
 * `buddy db:snapshot` - a consistent, checked, compressed copy of the
 * database, rotated, and sent off the box when a restic repository is
 * configured (app/Support/databaseSnapshot.ts).
 *
 * The 03:20 job. Safe while the app is serving: SQLite's online backup API
 * copies a consistent instant without stopping writers.
 */
export default function (cli: CLI) {
  cli
    .command('db:snapshot', 'Snapshot the database to DB_SNAPSHOT_DIR, keeping the newest N')
    .option('--keep [count]', 'Snapshots to keep', { default: 7 })
    .action(async (options: { keep: number }) => {
      const perf = await intro('buddy db:snapshot')
      try {
        const report = snapshotDatabase({ keep: Math.max(1, Number(options.keep) || 7) })
        if (report.offsite === 'not configured')
          log.warn('Kept on this box only: set DB_SNAPSHOT_RESTIC_ENV to send snapshots off it.')
        await outro(
          `Wrote ${report.file} (${Math.round(report.bytes / 1048576)} MB), removed ${report.pruned.length} old, off-box: ${report.offsite}`,
          { startTime: perf, useSeconds: true },
        )
        process.exit(ExitCode.Success)
      }
      catch (error) {
        log.error(`Snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(ExitCode.FatalError)
      }
    })
}

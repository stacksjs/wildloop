import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { snapshotDatabase } from '../Support/databaseSnapshot'
import { sendSnapshotOffsite } from '../Support/snapshotOffsite'

/**
 * `buddy db:snapshot` - a consistent, checked, compressed copy of the
 * database, rotated, and sent to Hetzner Object Storage when its credential
 * is configured (app/Support/databaseSnapshot.ts, app/Support/snapshotOffsite.ts).
 *
 * An upload that fails fails the command, so the scheduler reports it. No
 * credential at all only warns: that is a box not yet set up, not a backup
 * that broke.
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
        log.info(`Wrote ${report.file} (${Math.round(report.bytes / 1048576)} MB), removed ${report.pruned.length} old`)

        const offsite = await sendSnapshotOffsite(report.path, process.env)
        if (offsite.status === 'not configured')
          log.warn('Kept on this box only: set HETZNER_S3_ACCESS_KEY and HETZNER_S3_SECRET_KEY to send snapshots off it.')
        else
          log.info(`Sent to ${offsite.target}${offsite.pruned.length ? `, removed ${offsite.pruned.length} older` : ''}`)

        await outro(
          `Snapshot ${report.file}, off-box: ${offsite.status === 'sent' ? offsite.target : 'not configured'}`,
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

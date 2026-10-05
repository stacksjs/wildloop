import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { join } from 'node:path'
import { databasePath, pendingMigrations, snapshotDatabase } from '../Support/databaseSnapshot'
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
    .option('--before-migrations', 'Deploy mode: snapshot only when migrations are waiting, kept in their own rotation', { default: false })
    .action(async (options: { keep: number, beforeMigrations?: boolean }) => {
      const perf = await intro('buddy db:snapshot')
      try {
        // A deploy migrates before its release has proven anything. When it
        // has something to migrate, keep a copy from before the schema moves.
        // Nothing waiting, nothing to protect: the deploy is not slowed down.
        if (options.beforeMigrations) {
          const pending = pendingMigrations(databasePath(), join(process.cwd(), 'database/migrations'))
          if (pending.length === 0) {
            await outro('No migrations waiting, so no pre-migration snapshot', { startTime: perf, useSeconds: true })
            process.exit(ExitCode.Success)
          }
          log.info(`${pending.length} migration(s) waiting (${pending.slice(0, 3).join(', ')}${pending.length > 3 ? ', …' : ''}): snapshotting first`)
        }

        const report = snapshotDatabase({
          keep: Math.max(1, Number(options.keep) || 7),
          ...(options.beforeMigrations ? { label: 'pre-migration' as const } : {}),
        })
        log.info(`Wrote ${report.file} (${Math.round(report.bytes / 1048576)} MB), removed ${report.pruned.length} old`)

        // Pre-migration copies stay on the box: they are for undoing this
        // deploy within minutes, the nightly copy is the one that leaves, and
        // uploading the whole database would slow every migrating deploy.
        if (options.beforeMigrations) {
          await outro(`Pre-migration snapshot ${report.file} (on this box)`, { startTime: perf, useSeconds: true })
          process.exit(ExitCode.Success)
        }

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

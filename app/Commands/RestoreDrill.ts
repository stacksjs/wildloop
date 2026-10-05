import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { runRestoreDrill } from '../Support/restoreDrill'

/**
 * `buddy db:restore-drill` - restore the newest off-box snapshot into a
 * scratch file and prove it is a sound copy of the database
 * (app/Support/restoreDrill.ts). Weekly, from the scheduler; safe to run by
 * hand at any time, since it never touches the live database.
 */
export default function (cli: CLI) {
  cli
    .command('db:restore-drill', 'Restore the newest off-box snapshot to a scratch file and check it')
    .action(async () => {
      const perf = await intro('buddy db:restore-drill')
      try {
        const report = await runRestoreDrill(process.env)
        const rows = Object.entries(report.rows).map(([table, n]) => `${table} ${n.restored}/${n.live}`).join(', ')
        await outro(
          `Restored ${report.key} (${Math.round(report.bytes / 1048576)} MB, ${report.ageHours}h old): integrity ${report.integrity}; rows restored/live: ${rows}`,
          { startTime: perf, useSeconds: true },
        )
        process.exit(ExitCode.Success)
      }
      catch (error) {
        log.error(`Restore drill failed: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(ExitCode.FatalError)
      }
    })
}

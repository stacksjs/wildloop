import process from 'node:process'
import { schedule } from '@stacksjs/scheduler'

/**
 * **Scheduler**
 *
 * This is your Scheduler. Because Stacks is fully-typed, you may hover any of the
 * options below and the definitions will be provided. In case you have any
 * questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default function () {
  schedule.command('./buddy territory:ranks')
    .hourly()
    .withoutOverlapping(30)
    .onOneServer()
    .withName('wildloop-territory-ranks')

  // Tomorrow's trip plans, at six in the evening where each was made.
  schedule.command('./buddy plans:remind')
    .hourly()
    .withoutOverlapping(30)
    .onOneServer()
    .withName('wildloop-plan-reminders')

  schedule.command('./buddy territory:decay --apply')
    .at('03:10')
    .setTimeZone('UTC')
    .withoutOverlapping(60)
    .onOneServer()
    .withName('wildloop-territory-decay')

  schedule.command('./buddy counters:recompute')
    .at('04:10')
    .setTimeZone('UTC')
    .withoutOverlapping(60)
    .onOneServer()
    .withName('wildloop-counter-repair')

  /*
   * Elevation gain for the catalog, a slice a night (#1003).
   *
   * Nobody was ever going to type this. The command has been on the box since
   * 7a97b7ea and the catalog is still at 0% gain, because shipping a
   * maintenance command deploys the script and runs nothing — so the most-read
   * empty field on every trail page stayed empty, and difficulty stayed graded
   * on length alone (#1004).
   *
   * A slice rather than one pass: measuring 596,556 trails is days of work, and
   * a job that long has nowhere safe to be interrupted. This one does — it
   * selects on `elevation_checked_at`, so each night resumes where the last
   * stopped, and once the catalog is answered it costs one COUNT and exits.
   * The limit is deliberately conservative until the box's own rate is known
   * from the logs; the only measurement we have, 1.2 trails/s, is against the
   * public server over the internet and should be a floor rather than a guess.
   */
  schedule.command('./buddy trails:repair-elevation --limit 10000')
    .at('02:10')
    .setTimeZone('UTC')
    .withoutOverlapping(300)
    .onOneServer()
    .withName('wildloop-trail-elevation')
}

process.on('SIGINT', () => {
  schedule.gracefulShutdown().then(() => process.exit(0))
})

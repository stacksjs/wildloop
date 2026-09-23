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
}

process.on('SIGINT', () => {
  schedule.gracefulShutdown().then(() => process.exit(0))
})

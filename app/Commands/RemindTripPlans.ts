import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { defineModel } from '@stacksjs/orm'
import { ExitCode } from '@stacksjs/types'
import TripPlanDefinition from '../Models/TripPlan'
import UserNotificationDefinition from '../Models/UserNotification'
import { addDays, planReminderBody, planReminderDue } from '../../resources/functions/trip-plans'

const TripPlan = defineModel(TripPlanDefinition as any)
const UserNotification = defineModel(UserNotificationDefinition as any)

/**
 * `buddy plans:remind` — the evening-before reminder for tomorrow's plans.
 *
 * Runs hourly (app/Scheduler.ts). Each plan is judged in the timezone it was
 * made in, so a plan in Tokyo and one in San Diego are each reminded at six
 * in their own evening. The reminder is an in-app notification linking to
 * the plan, where the Apple Maps and Google Maps buttons are; the native app
 * also schedules its own on-device reminder when the plan is saved.
 *
 * `reminded_at` is set as each one goes out, so an overlapping or repeated
 * run cannot remind twice, and moving a plan to another day clears it.
 */
export default function (cli: CLI) {
  cli
    .command('plans:remind', 'Remind people about the trips they planned for tomorrow')
    .option('--dry-run', 'List who would be reminded without notifying anyone', { default: false })
    .action(async (options: { dryRun: boolean }) => {
      const perf = await intro('buddy plans:remind')
      const now = new Date()
      // Tomorrow somewhere on Earth spans three UTC dates; the per-plan check
      // below decides which of these are actually owed a reminder now.
      const utcToday = now.toISOString().slice(0, 10)
      const candidates = ((await TripPlan
        .where('planned_for', '>=', utcToday)
        .where('planned_for', '<=', addDays(utcToday, 2))
        .get()) ?? []) as any[]

      let sent = 0
      for (const plan of candidates) {
        if (!planReminderDue(plan, now))
          continue
        if (options.dryRun) {
          log.info(`would remind user ${plan.user_id}: ${planReminderBody(plan)}`)
          sent++
          continue
        }
        try {
          await UserNotification.forceCreate({
            recipient_id: plan.user_id,
            actor_id: null,
            actor_name: 'Wildloop',
            type: 'plan',
            body: planReminderBody(plan),
            link: `/plans#plan-${plan.id}`,
            read: false,
          })
          await TripPlan.where('id', '=', plan.id).update({ reminded_at: now.toISOString() })
          sent++
        }
        catch (error) {
          // One bad row must not stop everyone else's reminder.
          log.error(`plan ${plan.id}: ${(error as Error).message}`)
        }
      }

      log.success(`${sent} reminder${sent === 1 ? '' : 's'}${options.dryRun ? ' (dry run)' : ''} of ${candidates.length} plans in range`)
      await outro('Done', { startTime: perf, useSeconds: true })
      process.exit(ExitCode.Success)
    })
}

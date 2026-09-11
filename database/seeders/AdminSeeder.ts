import { Seeder } from '@stacksjs/database'
import { SEED_PASSWORD } from './UserSeeder'
import User from '../../app/Models/User'
import UserStat from '../../app/Models/UserStats'

/**
 * The account that can actually open /admin.
 *
 * `/admin` (and the sweeps behind `role:admin`) are gated by RBAC, not by a
 * column on `users` — AdminOverviewAction resolves the caller's role names and
 * refuses anything without `admin`. So a seeded database with five athletes in
 * it still had nobody who could see the dashboard: every one of them got a 403
 * and the page rendered its "This area is for administrators." error.
 *
 * This seeder closes that gap end to end. It ensures the default role packs
 * plus the application-level `paid` role exist, creates the explicit test
 * accounts, and assigns admin/client/paid access independently.
 *
 * Two accounts hold it on purpose, because they show different things:
 *
 *   - `admin@wildloop.test` owns nothing. Its /profile, /stats, /conquests
 *     and /notifications are the honest empty states, which is exactly what
 *     you want to be able to look at — those are the screens a brand new
 *     account sees, and they are the ones that quietly regress.
 *   - `chris@wildloop.test` is one of the seeded athletes AND an admin, so
 *     the same dashboards can be checked with a full history behind them.
 *
 * Staging only. The credentials are printed on purpose: these are throwaway
 * accounts on a throwaway catalog, and the whole point of a seeded environment
 * is that anyone on the team can sign in to it. Never run this against a real
 * database.
 */

/** Published in the seeder output. Staging only — see the note above. */
export const ADMIN_EMAIL = 'admin@wildloop.test'
export const ADMIN_PASSWORD = 'wildloop-admin'

export const NORMAL_EMAIL = 'user@wildloop.test'
export const PAID_EMAIL = 'paid@wildloop.test'

/** Seeded athletes who also hold the `admin` role. */
const ADMIN_ATHLETE_EMAILS = ['chris@wildloop.test']

export default class AdminSeeder extends Seeder {
  // After UserSeeder (-100), so the athletes it promotes already exist.
  static override order = -95

  /**
   * Runs on every deploy.
   *
   * The admin account and its role. Same as UserSeeder: already ran on
   * every deploy, now said out loud.
   *
   * The bar for this tag is both halves: idempotent, so a re-run changes
   * nothing, AND cheap, so a deploy does not wait for it. A seeder that
   * builds the demo corpus — trails, activities, the land derived from them
   * — is neither, and stays a deliberate one-off.
   */
  static override tags = ['deploy']

  async run(): Promise<void> {
    const { createBqbRbacStore, Rbac, seedDefaultRoles } = await import('@stacksjs/auth')
    Rbac.setStore(createBqbRbacStore())

    // Idempotent: existing (name, guard_name) rows are left untouched.
    await seedDefaultRoles()
    if (!await Rbac.findRole('paid'))
      await Rbac.createRole('paid', 'web', 'A WildLoop member with an active paid plan.')

    const existing = await User.where('email', '=', ADMIN_EMAIL).first().catch(() => null)
    const admin = existing
      ? (await User.update(existing.id, { name: 'WildLoop Admin', password: ADMIN_PASSWORD }), existing)
      : await User.create({
          name: 'WildLoop Admin',
          email: ADMIN_EMAIL,
          password: ADMIN_PASSWORD,
        })

    if (!admin?.id) {
      console.warn('[seed] admin account could not be created; skipping role assignment')
      return
    }

    // The admin is a real account, so it needs the stats row every athlete has
    // — /profile and the athlete directory both read through it, and a missing
    // row rendered the dashboard owner as an athlete with no history at all.
    const stats = await UserStat.where('user_id', '=', admin.id).first().catch(() => null)
    if (!stats) {
      await UserStat.forceCreate({
        user_id: admin.id,
        total_distance: 0,
        total_elevation: 0,
        trails_completed: 0,
        total_activities: 0,
        current_streak: 0,
        longest_streak: 0,
        total_kudos_received: 0,
        total_kudos_given: 0,
        weekly_rank: 0,
        total_time: '0',
      }).catch(() => null)
    }

    const promote = [admin.email, ...ADMIN_ATHLETE_EMAILS]
    for (const email of promote) {
      const user = email === admin.email
        ? admin
        : await User.where('email', '=', email).first().catch(() => null)
      if (!user?.id)
        continue

      // `assignRole` is a no-op when the user already holds it.
      await Rbac.assignRole({ id: user.id }, 'admin').catch((err: unknown) => {
        console.error(`[seed] could not grant admin to ${email}:`, err)
      })
    }

    const roleAssignments = [
      { email: NORMAL_EMAIL, roles: ['client'] },
      { email: PAID_EMAIL, roles: ['client', 'paid'] },
    ]
    for (const assignment of roleAssignments) {
      const user = await User.where('email', '=', assignment.email).first().catch(() => null)
      if (!user?.id)
        continue

      for (const role of assignment.roles) {
        await Rbac.assignRole({ id: user.id }, role).catch((err: unknown) => {
          console.error(`[seed] could not grant ${role} to ${assignment.email}:`, err)
        })
      }
    }

    console.warn(`[seed] admin sign-in: ${ADMIN_EMAIL} / ${ADMIN_PASSWORD} (holds no data — the empty states)`)
    for (const email of ADMIN_ATHLETE_EMAILS)
      console.warn(`[seed] admin sign-in: ${email} / ${SEED_PASSWORD} (a seeded athlete, so every page has data)`)
    console.warn(`[seed] normal user sign-in: ${NORMAL_EMAIL} / ${SEED_PASSWORD}`)
    console.warn(`[seed] paid user sign-in: ${PAID_EMAIL} / ${SEED_PASSWORD}`)
  }
}

import { Seeder } from '@stacksjs/database'
import User from '../../app/Models/User'
import UserStat from '../../app/Models/UserStats'

/**
 * The people who populate a staging environment.
 *
 * Not faker output. A feed, a leaderboard, and a club roster are all about
 * comparison, and generated names ("Zaria Bergnaum", "Kaley Wisozk") make
 * every screen read as obviously fake — you cannot tell whether a leaderboard
 * is sorting correctly when no name means anything to you. These are the
 * people the team actually recognises, with plausible numbers attached, so a
 * bug in ranking or a broken avatar is visible at a glance.
 *
 * Harvey Lewis is a real and very well-known backyard-ultra runner, which is
 * exactly why his numbers here are deliberately the largest: the backyard
 * pages exist to show a field shrinking over dozens of yards, and that needs
 * someone at the top with a believable count on them.
 *
 * All of these are TEST accounts on a staging catalog. Every password is the
 * same throwaway string and none of these addresses receive mail — this seeder
 * must never run against a real production database, which is why it lives
 * behind `buddy db:seed` and is not part of a deploy.
 */

interface SeedUser {
  name: string
  email: string
  stats: {
    total_distance: number
    total_elevation: number
    trails_completed: number
    total_activities: number
    current_streak: number
    longest_streak: number
    total_kudos_received: number
    total_kudos_given: number
  }
}

/** Shared across every seeded athlete. Staging only — see the note above. */
export const SEED_PASSWORD = 'wildloop-staging'

const USERS: SeedUser[] = [
  {
    name: 'WildLoop User',
    email: 'user@wildloop.test',
    stats: {
      total_distance: 42.2,
      total_elevation: 3100,
      trails_completed: 4,
      total_activities: 9,
      current_streak: 2,
      longest_streak: 5,
      total_kudos_received: 12,
      total_kudos_given: 18,
    },
  },
  {
    name: 'WildLoop Paid User',
    email: 'paid@wildloop.test',
    stats: {
      total_distance: 286.4,
      total_elevation: 24750,
      trails_completed: 23,
      total_activities: 71,
      current_streak: 6,
      longest_streak: 19,
      total_kudos_received: 214,
      total_kudos_given: 306,
    },
  },
  {
    name: 'Chris Breuer',
    email: 'chris@wildloop.test',
    stats: {
      total_distance: 1284.6,
      total_elevation: 142900,
      trails_completed: 96,
      total_activities: 412,
      current_streak: 12,
      longest_streak: 54,
      total_kudos_received: 1890,
      total_kudos_given: 2240,
    },
  },
  {
    name: 'Pawel Dregan',
    email: 'pawel@wildloop.test',
    stats: {
      total_distance: 1642.3,
      total_elevation: 188400,
      trails_completed: 118,
      total_activities: 486,
      current_streak: 21,
      longest_streak: 63,
      total_kudos_received: 2310,
      total_kudos_given: 1975,
    },
  },
  {
    name: 'Kim Gottwald',
    email: 'kim@wildloop.test',
    stats: {
      total_distance: 968.4,
      total_elevation: 121350,
      trails_completed: 74,
      total_activities: 298,
      current_streak: 8,
      longest_streak: 41,
      total_kudos_received: 1420,
      total_kudos_given: 1680,
    },
  },
  {
    name: 'Mark Dowdle',
    email: 'mark@wildloop.test',
    stats: {
      total_distance: 1105.9,
      total_elevation: 96700,
      trails_completed: 88,
      total_activities: 354,
      current_streak: 4,
      longest_streak: 37,
      total_kudos_received: 1615,
      total_kudos_given: 1290,
    },
  },
  {
    name: 'Harvey Lewis',
    email: 'harvey@wildloop.test',
    stats: {
      // Backyard distances are a different sport: 100 yards is 417 miles in a
      // single event. The leaderboard has to look right with a number like
      // this at the top of it.
      total_distance: 4212.7,
      total_elevation: 214600,
      trails_completed: 141,
      total_activities: 590,
      current_streak: 46,
      longest_streak: 108,
      total_kudos_received: 8640,
      total_kudos_given: 3120,
    },
  },
]

export default class UserSeeder extends Seeder {
  // Clubs, activities and territories all point at a user. Seeding runs in
  // path order by default, which put ClubSeeder first and left it with no
  // owner to attach a club to.
  static override order = -100

  /**
   * Runs on every deploy.
   *
   * The test accounts the environment is signed into. Already ran on
   * every deploy before tags existed; this is that same decision, declared.
   *
   * The bar for this tag is both halves: idempotent, so a re-run changes
   * nothing, AND cheap, so a deploy does not wait for it. A seeder that
   * builds the demo corpus — trails, activities, the land derived from them
   * — is neither, and stays a deliberate one-off.
   */
  static override tags = ['deploy']

  async run(): Promise<void> {
    for (const seed of USERS) {
      // Idempotent by email: re-seeding updates in place rather than filling
      // the athlete directory with duplicates of the same five people.
      const existing = await User.where('email', '=', seed.email).first().catch(() => null)

      const user = existing
        ? (await User.update(existing.id, { name: seed.name, password: SEED_PASSWORD }), existing)
        : await User.create({
            name: seed.name,
            email: seed.email,
            password: SEED_PASSWORD,
          })

      if (!user?.id)
        continue

      const stats = await UserStat.where('user_id', '=', user.id).first().catch(() => null)
      const payload = { ...seed.stats, user_id: user.id, weekly_rank: 0, total_time: '0' }

      if (stats)
        await UserStat.update(stats.id, payload)
      else
        await UserStat.forceCreate(payload).catch(() => null)
    }

    // Ranks come from the seeded distances rather than being written by hand,
    // so they cannot drift out of agreement with the numbers above.
    const ranked = await UserStat.orderBy('total_distance', 'desc').get().catch(() => [])
    for (const [index, row] of (ranked as any[]).entries())
      await UserStat.update(row.id, { weekly_rank: index + 1 }).catch(() => null)
  }
}

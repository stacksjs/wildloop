import { Seeder } from '@stacksjs/database'
import Follow from '../../app/Models/Follow'
import User from '../../app/Models/User'

/**
 * The social graph between the seeded athletes.
 *
 * Without it the athlete directory shows five people with no followers, the
 * profile pages report 0/0, the follow button has no "following" state to
 * render, and `visibility: 'followers'` on an activity is a rule nothing
 * exercises.
 *
 * The edges are named rather than generated because a follow graph is read as
 * relationships: Harvey is the athlete everybody follows, Chris and Pawel
 * train together and follow each other, and the admin account follows the
 * whole roster because that is what an account watching a staging environment
 * would do. A random graph gives the same row count and none of that.
 *
 * Idempotent on (follower, following), the table's own unique index.
 */

/** follower → the people they follow. */
const GRAPH: Record<string, string[]> = {
  'Chris Breuer': ['Harvey Lewis', 'Pawel Dregan', 'Kim Gottwald'],
  'Pawel Dregan': ['Harvey Lewis', 'Chris Breuer'],
  'Kim Gottwald': ['Harvey Lewis', 'Chris Breuer', 'Mark Dowdle'],
  'Mark Dowdle': ['Harvey Lewis', 'Kim Gottwald'],
  'Harvey Lewis': ['Chris Breuer', 'Mark Dowdle'],
  'Wildloop Admin': ['Chris Breuer', 'Pawel Dregan', 'Kim Gottwald', 'Mark Dowdle', 'Harvey Lewis'],
}

export default class FollowSeeder extends Seeder {
  // After UserSeeder (-100) and AdminSeeder (-95): both ends must exist.
  static override order = -66

  async run(): Promise<void> {
    const users = (await User.all().catch(() => [])) as any[]
    const byName = new Map(users.map(u => [u.name, u]))
    if (!byName.size) {
      console.warn('[seed] no users yet; skipping follows')
      return
    }

    for (const [followerName, followingNames] of Object.entries(GRAPH)) {
      const follower = byName.get(followerName)
      if (!follower)
        continue

      for (const followingName of followingNames) {
        const following = byName.get(followingName)
        if (!following || following.id === follower.id)
          continue

        const existing = await Follow
          .where('follower_id', '=', follower.id)
          .where('following_id', '=', following.id)
          .first()
          .catch(() => null)

        if (!existing)
          await Follow.forceCreate({ follower_id: follower.id, following_id: following.id })
      }
    }
  }
}

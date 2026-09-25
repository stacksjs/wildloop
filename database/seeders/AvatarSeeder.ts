import { Seeder } from '@stacksjs/database'
import { db } from '@stacksjs/orm'
import { join } from 'node:path'
import { avatarSourceFor, SEEDED_ATHLETES, seedAvatar } from '../../app/Support/avatarSeeding'
import { photoStorage, PhotoStorageNotConfiguredError } from '../../app/Support/photoStorage'

/**
 * Profile photos for the seeded athletes.
 *
 * Chris Breuer's is his own photo, committed as
 * `database/seeders/avatars/chris-breuer.jpg`. Everyone else is a real person
 * too, so they get generated art (their initials on a topographic map drawn
 * from their name) instead of a stranger's face. Dropping a real
 * `database/seeders/avatars/<slug>.jpg` in later replaces the art on the next
 * seed. See app/Support/avatarSeeding.ts for the rules.
 *
 * Written through the photo store, so it lands in S3 in production and on
 * the local disk in development, exactly where uploads go.
 */
export default class AvatarSeeder extends Seeder {
  // After UserSeeder (-100) and AdminSeeder (-95): it needs their accounts.
  static override order = -90

  /**
   * Runs on every deploy.
   *
   * Idempotent: a seeded avatar is found in place by its URL, which is derived
   * from its source, and an avatar somebody uploaded is never replaced. Cheap:
   * once the avatars exist, a run is one query per athlete and no image work.
   */
  static override tags = ['deploy']

  async run(): Promise<void> {
    let store
    try {
      store = photoStorage()
    }
    catch (error) {
      // Avatars are decoration. A box without photo storage should still
      // deploy, with the initials it had before.
      if (error instanceof PhotoStorageNotConfiguredError) {
        console.warn(`[seed] avatars skipped: ${error.message}`)
        return
      }
      throw error
    }

    const directory = join(import.meta.dir, 'avatars')
    for (const athlete of SEEDED_ATHLETES) {
      const user = (await db.sql`SELECT id, name, avatar FROM users WHERE email = ${athlete.email}`.execute() as any[])[0]
      if (!user?.id)
        continue

      const userId = Number(user.id)
      try {
        const decision = await seedAvatar({
          userId,
          current: user.avatar,
          source: avatarSourceFor(athlete.slug, String(user.name ?? ''), directory),
          store,
          save: async (avatar, previous) => {
            await (previous
              ? db.sql`UPDATE users SET avatar = ${avatar} WHERE id = ${userId} AND avatar = ${previous}`
              : db.sql`UPDATE users SET avatar = ${avatar} WHERE id = ${userId} AND avatar IS NULL`
            ).execute()
            const after = (await db.sql`SELECT avatar FROM users WHERE id = ${userId}`.execute() as any[])[0]
            return after?.avatar === avatar
          },
        })
        if (decision === 'set')
          console.warn(`[seed] avatar set for ${athlete.email}`)
      }
      catch (error) {
        // One athlete's photo is not worth a failed deploy.
        console.error(`[seed] could not seed the avatar for ${athlete.email}:`, error)
      }
    }
  }
}

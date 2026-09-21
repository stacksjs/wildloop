import { db } from '@stacksjs/orm'
import { computeCounterFixes } from '../../resources/functions/counters'
import { photoStorage } from './photoStorage'
import { inWriteTransaction } from './writeTransaction'

/**
 * Deleting an account, from inside the app (App Store guideline 5.1.1(v): an
 * app that lets people sign up has to let them delete the account there too).
 *
 * What goes:
 *   Everything the athlete made. Their activities, with every comment, kudos,
 *   lap, effort and import attached to them; their photos, files included;
 *   reviews, comments, kudos, saved trails, routes, achievements and stats;
 *   follows in both directions, blocks and reports they filed; notifications
 *   to them or about them; and every sign-in: tokens, push registrations,
 *   passkeys, two-factor state, the Garmin link.
 *
 * What stays, without them:
 *   Their territories become claimable. Battle history keeps each event but no
 *   longer names them. A club they created passes to its longest-standing
 *   member; one with nobody else in it is deleted. Events they host are
 *   deleted with their entrants and laps, since nobody else runs them.
 *
 * Counts on other people's things (a trail's rating, an activity's kudos) are
 * recomputed. It all happens in one transaction: a failure leaves the account
 * exactly as it was.
 */

export interface AccountDeletionReport {
  activities: number
  reviews: number
  photos: number
  territoriesReleased: number
  clubsHandedOver: number
  clubsDeleted: number
  eventsDeleted: number
}

interface MemberRow {
  id: number
  user_id: number
  created_at: string
}

/** Who inherits a club: the member who joined first, other than the one leaving. */
export function clubSuccessor(members: readonly MemberRow[], leavingUserId: number): number | null {
  const remaining = members
    .filter(member => Number(member.user_id) !== leavingUserId)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id - b.id)
  return remaining[0] ? Number(remaining[0].user_id) : null
}

/** Only whole positive ids are ever inlined into SQL. */
function idList(values: readonly unknown[]): number[] {
  return [...new Set(values.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))]
}

async function rows<T = any>(query: { execute: () => Promise<unknown> }): Promise<T[]> {
  return ((await query.execute()) ?? []) as T[]
}

export async function deleteAccount(userId: number): Promise<AccountDeletionReport> {
  if (!Number.isSafeInteger(userId) || userId <= 0)
    throw new Error('deleteAccount needs a real user id')

  const photos = await rows<{ storage_key: string, thumb_key: string | null }>(
    db.sql`SELECT storage_key, thumb_key FROM trail_photos WHERE user_id = ${userId}`,
  )

  const report = await inWriteTransaction(async () => {
    const user = (await rows<{ email: string }>(db.sql`SELECT email FROM users WHERE id = ${userId}`))[0]
    const activityIds = idList((await rows(db.sql`SELECT id FROM activities WHERE user_id = ${userId}`)).map(r => r.id))
    const reviewedTrailIds = idList((await rows(db.sql`SELECT DISTINCT trail_id FROM trail_reviews WHERE user_id = ${userId}`)).map(r => r.trail_id))
    // `kudos.user_id` is the owner of the activity that received it; the one
    // who gave it is `giver_id`.
    const kudoedActivityIds = idList((await rows(db.sql`SELECT DISTINCT activity_id FROM kudos WHERE giver_id = ${userId}`)).map(r => r.activity_id))
      .filter(id => !activityIds.includes(id))
    const reviewCount = (await rows(db.sql`SELECT id FROM trail_reviews WHERE user_id = ${userId}`)).length

    // Events they host go, with everything entered in them.
    const hostedEventIds = idList((await rows(db.sql`SELECT id FROM events WHERE host_id = ${userId}`)).map(r => r.id))

    // Clubs they created pass on, or go when nobody else is in them.
    let clubsHandedOver = 0
    const orphanedClubIds: number[] = []
    for (const club of await rows<{ id: number }>(db.sql`SELECT id FROM clubs WHERE creator_id = ${userId}`)) {
      const members = await rows<MemberRow>(db.sql`SELECT id, user_id, created_at FROM club_members WHERE club_id = ${club.id}`)
      const successor = clubSuccessor(members, userId)
      if (successor === null) {
        orphanedClubIds.push(Number(club.id))
        continue
      }
      await db.sql`UPDATE clubs SET creator_id = ${successor} WHERE id = ${club.id}`.execute()
      await db.sql`UPDATE club_members SET role = 'owner' WHERE club_id = ${club.id} AND user_id = ${successor}`.execute()
      clubsHandedOver++
    }
    const clubIds = idList(orphanedClubIds)
    const clubEventIds = clubIds.length
      ? idList((await rows(db.sql`SELECT id FROM events WHERE club_id IN (${db.unsafe(clubIds.join(', '))})`)).map(r => r.id))
      : []
    const eventIds = idList([...hostedEventIds, ...clubEventIds])

    if (eventIds.length) {
      const inEvents = db.unsafe(eventIds.join(', '))
      await db.sql`DELETE FROM event_laps WHERE event_id IN (${inEvents})`.execute()
      await db.sql`DELETE FROM event_entrants WHERE event_id IN (${inEvents})`.execute()
      await db.sql`DELETE FROM events WHERE id IN (${inEvents})`.execute()
    }
    if (clubIds.length) {
      const inClubs = db.unsafe(clubIds.join(', '))
      await db.sql`DELETE FROM club_invites WHERE club_id IN (${inClubs})`.execute()
      await db.sql`DELETE FROM club_members WHERE club_id IN (${inClubs})`.execute()
      await db.sql`DELETE FROM clubs WHERE id IN (${inClubs})`.execute()
    }

    // What hangs off their activities, then the activities themselves. Land
    // and battle history refer to the activity that made them; they keep the
    // record and drop the reference.
    if (activityIds.length) {
      const inActivities = db.unsafe(activityIds.join(', '))
      await db.sql`DELETE FROM activity_comments WHERE activity_id IN (${inActivities})`.execute()
      await db.sql`DELETE FROM kudos WHERE activity_id IN (${inActivities})`.execute()
      await db.sql`DELETE FROM event_laps WHERE activity_id IN (${inActivities})`.execute()
      await db.sql`DELETE FROM route_efforts WHERE activity_id IN (${inActivities})`.execute()
      await db.sql`DELETE FROM garmin_activity_imports WHERE activity_id IN (${inActivities})`.execute()
      await db.sql`DELETE FROM territory_activity_resolutions WHERE activity_id IN (${inActivities})`.execute()
      await db.sql`UPDATE territories SET activity_id = NULL WHERE activity_id IN (${inActivities})`.execute()
      await db.sql`UPDATE territory_histories SET activity_id = NULL WHERE activity_id IN (${inActivities})`.execute()
    }

    // Their land becomes claimable; the history keeps the events, not the name.
    const territoriesReleased = (await rows(db.sql`SELECT id FROM territories WHERE user_id = ${userId}`)).length
    await db.sql`UPDATE territories SET user_id = NULL, status = 'expired' WHERE user_id = ${userId}`.execute()
    await db.sql`UPDATE territory_histories SET user_id = NULL WHERE user_id = ${userId}`.execute()
    await db.sql`UPDATE territory_histories SET previous_owner_id = NULL WHERE previous_owner_id = ${userId}`.execute()
    await db.sql`DELETE FROM territory_stats WHERE user_id = ${userId}`.execute()

    // Other people's records keep their shape without pointing at them.
    await db.sql`DELETE FROM challenges WHERE challenger_id = ${userId} OR challenged_id = ${userId}`.execute()
    await db.sql`UPDATE challenges SET winner_id = NULL WHERE winner_id = ${userId}`.execute()
    await db.sql`UPDATE events SET winner_id = NULL WHERE winner_id = ${userId}`.execute()
    await db.sql`UPDATE route_efforts SET reviewed_by = NULL WHERE reviewed_by = ${userId}`.execute()
    await db.sql`UPDATE content_reports SET resolved_by = NULL WHERE resolved_by = ${userId}`.execute()

    await db.sql`DELETE FROM activities WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM activity_comments WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM kudos WHERE giver_id = ${userId} OR user_id = ${userId}`.execute()
    await db.sql`DELETE FROM follows WHERE follower_id = ${userId} OR following_id = ${userId}`.execute()
    await db.sql`DELETE FROM trail_reviews WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM trail_photos WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM saved_trails WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM route_efforts WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM custom_routes WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM event_laps WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM event_entrants WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM club_invites WHERE invited_user_id = ${userId} OR invited_by_id = ${userId}`.execute()
    await db.sql`DELETE FROM club_members WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM user_achievements WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM user_stats WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM user_privacy_settings WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM user_notifications WHERE recipient_id = ${userId} OR actor_id = ${userId}`.execute()
    await db.sql`DELETE FROM notifications WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM notification_preferences WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM notification_deliveries WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM commentable_upvotes WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM commentables WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM content_reports WHERE reporter_id = ${userId}`.execute()
    await db.sql`DELETE FROM user_blocks WHERE blocker_id = ${userId} OR blocked_id = ${userId}`.execute()

    // Every way back in.
    await db.sql`DELETE FROM device_push_tokens WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM garmin_activity_imports WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM garmin_connections WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM passkeys WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM webauthn_challenges WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM two_factor_challenges WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM two_factor_pending_secrets WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM email_verifications WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM user_roles WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM user_permissions WHERE user_id = ${userId}`.execute()
    await db.sql`DELETE FROM oauth_refresh_tokens WHERE access_token_id IN (SELECT id FROM oauth_access_tokens WHERE user_id = ${userId} OR tokenable_id = ${userId})`.execute()
    await db.sql`DELETE FROM oauth_access_tokens WHERE user_id = ${userId} OR tokenable_id = ${userId}`.execute()
    if (user?.email)
      await db.sql`DELETE FROM password_resets WHERE email = ${user.email}`.execute()

    await db.sql`DELETE FROM users WHERE id = ${userId}`.execute()

    await recomputeCounters(reviewedTrailIds, kudoedActivityIds)

    return {
      activities: activityIds.length,
      reviews: reviewCount,
      photos: photos.length,
      territoriesReleased,
      clubsHandedOver,
      clubsDeleted: clubIds.length,
      eventsDeleted: eventIds.length,
    }
  })

  // Files last, once the rows are gone for good. A file that will not delete
  // is logged, not allowed to undo the deletion.
  const store = photoStorage()
  for (const photo of photos) {
    for (const key of [photo.storage_key, photo.thumb_key]) {
      if (key)
        await store.deleteFile(key).catch((error: unknown) => console.error('[account] could not delete photo file', key, error))
    }
  }

  return report
}

/** The same rules as `buddy counters:recompute`, for just the trails and activities touched. */
async function recomputeCounters(trailIds: number[], activityIds: number[]): Promise<void> {
  const trails = trailIds.length
    ? await rows(db.sql`SELECT id, rating, review_count FROM trails WHERE id IN (${db.unsafe(trailIds.join(', '))})`)
    : []
  const reviews = trailIds.length
    ? await rows(db.sql`SELECT trail_id, rating FROM trail_reviews WHERE trail_id IN (${db.unsafe(trailIds.join(', '))})`)
    : []
  const activities = activityIds.length
    ? await rows(db.sql`SELECT id, kudos_count FROM activities WHERE id IN (${db.unsafe(activityIds.join(', '))})`)
    : []
  const kudos = activityIds.length
    ? await rows(db.sql`SELECT activity_id FROM kudos WHERE activity_id IN (${db.unsafe(activityIds.join(', '))})`)
    : []

  const fixes = computeCounterFixes({ activities, kudos, trails, reviews })
  for (const fix of fixes.trailFixes)
    await db.sql`UPDATE trails SET rating = ${fix.rating}, review_count = ${fix.review_count} WHERE id = ${fix.id}`.execute()
  for (const fix of fixes.activityFixes)
    await db.sql`UPDATE activities SET kudos_count = ${fix.kudos_count} WHERE id = ${fix.id}`.execute()
}

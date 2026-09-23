import { Seeder } from '@stacksjs/database'
import Activity from '../../app/Models/Activity'
import ActivityComment from '../../app/Models/ActivityComment'
import Challenge from '../../app/Models/Challenge'
import Follow from '../../app/Models/Follow'
import Kudos from '../../app/Models/Kudos'
import Territory from '../../app/Models/Territory'
import TerritoryHistory from '../../app/Models/TerritoryHistory'
import User from '../../app/Models/User'
import UserNotification from '../../app/Models/UserNotification'

/**
 * The notification feed, derived from the things that actually happened.
 *
 * `/notifications` reads this table and nothing else, so an empty one leaves
 * the page, its unread badge and the mark-as-read control with nothing to act
 * on. But a notification is not a thing in its own right: it is the record of
 * somebody doing something to you, and the write paths create one at the
 * moment they do it — KudosToggleAction on a kudos, FollowToggleAction on a
 * follow, the conquest engine when your land changes hands.
 *
 * So this seeder writes none of its own. It walks the rows the other seeders
 * produced — kudos, comments, follows, territory history, challenges — and
 * emits the notification each of those events would have raised, addressed to
 * the person it happened to. Nothing here can describe an event that did not
 * occur, and an event with no notification is a gap you can see.
 *
 * Read state is assigned by age rather than at random: anything from the last
 * two days is still unread, older items have been seen. That gives the unread
 * badge a number that moves as the seed ages instead of a constant.
 */

const DAY = 24 * 60 * 60 * 1000
const UNREAD_WINDOW_DAYS = 2

interface Emitted {
  recipient_id: number
  actor_id: number
  actor_name: string
  type: string
  body: string
  link: string
  created_at: string
}

export default class UserNotificationSeeder extends Seeder {
  // Last of the content seeders: it reports on everything the others wrote.
  static override order = -54

  async run(): Promise<void> {
    const users = (await User.all().catch(() => [])) as any[]
    if (!users.length) {
      console.warn('[seed] no users yet; skipping notifications')
      return
    }

    const nameById = new Map(users.map(u => [u.id, u.name as string]))
    const activities = (await Activity.all().catch(() => [])) as any[]
    const activityById = new Map(activities.map(a => [a.id, a]))
    const territories = (await Territory.all().catch(() => [])) as any[]
    const territoryById = new Map(territories.map(t => [t.id, t]))

    const emitted: Emitted[] = []
    /**
     * When the event being reported happened.
     *
     * A kudos or a comment lands on a run, and the run is what carries a real
     * date — the reaction row itself is stamped with whenever the seeder ran,
     * which would put the entire feed inside the unread window and leave the
     * read state untested. Where there is no better time than the row's own
     * (a follow), that is what gets used.
     */
    const at = (...candidates: Array<string | null | undefined>): string =>
      candidates.find(value => !!value) ?? new Date().toISOString()

    // Kudos → "gave your run kudos", to the athlete who logged it.
    for (const kudos of (await Kudos.all().catch(() => [])) as any[]) {
      const activity = activityById.get(kudos.activity_id)
      const recipient = kudos.user_id ?? activity?.user_id
      if (!recipient || recipient === kudos.giver_id)
        continue
      emitted.push({
        recipient_id: recipient,
        actor_id: kudos.giver_id,
        actor_name: nameById.get(kudos.giver_id) ?? 'An athlete',
        type: 'kudos',
        body: `${nameById.get(kudos.giver_id) ?? 'An athlete'} gave kudos on your ${activity?.activity_type ?? 'activity'}.`,
        link: `/activity/${kudos.activity_id}`,
        created_at: at(activity?.completed_at, kudos.created_at),
      })
    }

    // Comments → to the owner of the activity, not to the other commenters.
    for (const comment of (await ActivityComment.all().catch(() => [])) as any[]) {
      const activity = activityById.get(comment.activity_id)
      if (!activity || activity.user_id === comment.user_id)
        continue
      emitted.push({
        recipient_id: activity.user_id,
        actor_id: comment.user_id,
        actor_name: nameById.get(comment.user_id) ?? 'An athlete',
        type: 'comment',
        body: `${nameById.get(comment.user_id) ?? 'An athlete'} commented: "${comment.body}"`,
        link: `/activity/${comment.activity_id}`,
        created_at: at(activity.completed_at, comment.created_at),
      })
    }

    // Follows → to the person being followed.
    for (const follow of (await Follow.all().catch(() => [])) as any[]) {
      emitted.push({
        recipient_id: follow.following_id,
        actor_id: follow.follower_id,
        actor_name: nameById.get(follow.follower_id) ?? 'An athlete',
        type: 'follow',
        body: `${nameById.get(follow.follower_id) ?? 'An athlete'} started following you.`,
        link: `/athlete/${follow.follower_id}`,
        created_at: at(follow.created_at),
      })
    }

    // Territory events → the two sides of a battle get different news, which
    // is what the separate conquest_* types are for.
    for (const event of (await TerritoryHistory.all().catch(() => [])) as any[]) {
      const territory = territoryById.get(event.territory_id)
      const territoryName = territory?.name ?? `Territory #${event.territory_id}`
      const actorName = nameById.get(event.user_id) ?? 'An athlete'
      const link = `/territory/${event.territory_id}`

      if (event.event_type === 'conquered') {
        emitted.push({
          recipient_id: event.user_id,
          actor_id: event.user_id,
          actor_name: 'Wildloop',
          type: 'conquest_win',
          body: `You took ${territoryName}.`,
          link,
          created_at: at(event.created_at),
        })
        if (event.previous_owner_id) {
          emitted.push({
            recipient_id: event.previous_owner_id,
            actor_id: event.user_id,
            actor_name: actorName,
            type: 'conquest',
            body: `${actorName} took ${territoryName} from you.`,
            link,
            created_at: at(event.created_at),
          })
        }
      }
      else if (event.event_type === 'contested' && territory && territory.user_id !== event.user_id) {
        emitted.push({
          recipient_id: territory.user_id,
          actor_id: event.user_id,
          actor_name: actorName,
          type: 'conquest_attack',
          body: `${actorName} ran through ${territoryName}. It is under attack.`,
          link,
          created_at: at(event.created_at),
        })
      }
      else if (event.event_type === 'defended') {
        emitted.push({
          recipient_id: event.user_id,
          actor_id: event.user_id,
          actor_name: 'Wildloop',
          type: 'conquest_defend',
          body: `You held ${territoryName}.`,
          link,
          created_at: at(event.created_at),
        })
      }
    }

    // Challenges → to the athlete being challenged.
    for (const challenge of (await Challenge.all().catch(() => [])) as any[]) {
      const actorName = nameById.get(challenge.challenger_id) ?? 'An athlete'
      const territoryName = territoryById.get(challenge.territory_id)?.name ?? 'a territory'
      emitted.push({
        recipient_id: challenge.challenged_id,
        actor_id: challenge.challenger_id,
        actor_name: actorName,
        type: 'challenge',
        body: `${actorName} challenged you for ${territoryName}.`,
        link: '/challenges',
        created_at: at(challenge.created_at),
      })
    }

    const unreadSince = Date.now() - UNREAD_WINDOW_DAYS * DAY

    for (const notification of emitted) {
      const payload = {
        ...notification,
        read: new Date(notification.created_at).getTime() < unreadSince,
      }

      // Keyed on the event it reports: one recipient, one actor, one type, one
      // body. Re-seeding refreshes the row rather than sending it twice.
      const existing = await UserNotification
        .where('recipient_id', '=', notification.recipient_id)
        .where('actor_id', '=', notification.actor_id)
        .where('type', '=', notification.type)
        .where('body', '=', notification.body)
        .first()
        .catch(() => null)

      if (existing) {
        await UserNotification.forceUpdate(existing.id, payload)
        continue
      }

      await UserNotification.forceCreate(payload)
      // `useTimestamps` overwrites `created_at` on INSERT, so the date of the
      // event being reported has to be written back after it. Without this
      // every notification arrives "just now" and the read/unread split below
      // never has anything old enough to mark read.
      const created = await UserNotification
        .where('recipient_id', '=', notification.recipient_id)
        .where('actor_id', '=', notification.actor_id)
        .where('type', '=', notification.type)
        .where('body', '=', notification.body)
        .first()
        .catch(() => null)
      if (created)
        await UserNotification.forceUpdate(created.id, { created_at: notification.created_at })
    }
  }
}

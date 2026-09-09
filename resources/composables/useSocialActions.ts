import { toggleFollow, toggleKudos } from '../assets/scripts/game-api'
import { requireAuth } from './useAuthGate'

/**
 * Follow and kudos, in one place and gated the same way.
 *
 * Both were written out by hand in the feed and again on the athlete
 * directory, and both had the same hole: signed out, the optimistic toggle
 * flipped, the API refused the write, and the rollback put it back — a button
 * that visibly did nothing. Sharing them means one definition of what the
 * button does and one definition of what happens when you are not signed in.
 */

interface FollowStoreLike {
  currentUserId: () => number
  isFollowing: (userId: number) => boolean
  setFollowing: (userId: number, following: boolean) => void
}

interface KudosStoreLike {
  currentUserId: () => number
  setActivityKudos: (activityId: number, count: number) => void
}

/** Optimistic follow/unfollow that opens the sign-in gate when it has to. */
export async function followAthlete(wl: FollowStoreLike | null, userId: number): Promise<void> {
  if (!wl || !userId || userId === wl.currentUserId())
    return

  if (!requireAuth('Follow athletes to see their runs in your feed.', () => { void followAthlete(wl, userId) }))
    return

  const was = wl.isFollowing(userId)
  wl.setFollowing(userId, !was) // optimistic
  const res = await toggleFollow(userId)
  if (res && res.success)
    wl.setFollowing(userId, !!res.following)
  else
    wl.setFollowing(userId, was) // rollback
}

export interface KudosTarget {
  id: number
  kudos_count: number
}

/**
 * Optimistic kudos. `kudosed` is the caller's own map of which activities this
 * visitor has already given kudos to — returned updated rather than mutated,
 * so the caller keeps control of its signal.
 */
export async function giveKudos(
  wl: KudosStoreLike | null,
  activity: KudosTarget,
  kudosed: Record<number, boolean>,
  apply: (next: Record<number, boolean>) => void,
): Promise<void> {
  if (!wl)
    return

  if (!requireAuth('Give kudos to cheer on other athletes.', () => { void giveKudos(wl, activity, kudosed, apply) }))
    return

  const was = kudosed[activity.id] ?? false
  apply({ ...kudosed, [activity.id]: !was })
  wl.setActivityKudos(activity.id, Math.max(0, activity.kudos_count + (was ? -1 : 1)))

  const res = await toggleKudos(activity.id, wl.currentUserId())
  if (res && res.success) {
    apply({ ...kudosed, [activity.id]: !!res.kudosed })
    if (typeof res.kudosCount === 'number')
      wl.setActivityKudos(activity.id, res.kudosCount)
    return
  }

  apply({ ...kudosed, [activity.id]: was })
  wl.setActivityKudos(activity.id, activity.kudos_count)
}

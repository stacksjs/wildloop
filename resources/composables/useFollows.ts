import { onMount } from 'stx'
import { initializeAuthSession } from '../assets/scripts/auth'
import { fetchFollows } from '../assets/scripts/game-api'

/**
 * Hydrate the current user's following list into the `wl` store so the feed's
 * "Following" filter and follow buttons reflect real data. Silent on failure.
 */

interface FollowStoreLike {
  currentUserId: () => number
  hydrateFollowing: (ids: number[]) => void
}

let followsStarted = false

export async function hydrateFollows(wl: FollowStoreLike | null): Promise<void> {
  if (!wl || followsStarted)
    return
  // Whose list this is comes from the session, which is still being restored
  // on a first load. Reading the id before it is asked for /api/users/0, and
  // marking the load done meant the real one never followed.
  await initializeAuthSession()
  const userId = wl.currentUserId()
  if (followsStarted || userId <= 0)
    return
  followsStarted = true
  try {
    const data = await fetchFollows(userId)
    if (data && Array.isArray(data.followingIds))
      wl.hydrateFollowing(data.followingIds)
  }
  catch {
    // ignore - keep empty following list
  }
}

export function useFollows(wl: FollowStoreLike | null) {
  onMount(() => void hydrateFollows(wl))
}

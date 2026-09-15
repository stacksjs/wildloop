import { onMount } from 'stx'
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
  followsStarted = true
  try {
    const data = await fetchFollows(wl.currentUserId())
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

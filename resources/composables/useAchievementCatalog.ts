import { onMount, state } from 'stx'
import { initializeAuthSession } from '../assets/scripts/auth'
import { fetchAchievements } from '../assets/scripts/game-api'

/**
 * Hydrate the `wl` store's achievements from the live unlock engine
 * (`GET /api/users/{id}/achievements`, #982), mirroring useActivityCatalog.
 *
 * An empty wall is a real answer, and the same reasoning the activity and
 * territory catalogs record applies here: returning early on a zero-length
 * list left the store's demo badges on screen, so an account that has earned
 * nothing was shown achievements it never unlocked. Only an unreachable API
 * falls back now.
 */

interface AchievementStoreLike {
  currentUserId: () => number
  hydrateAchievements: (achievements: unknown[]) => void
}

export const achievementSource = state<'api' | 'seed'>('seed')

let achievementsStarted = false

export function useAchievementCatalog(wl: AchievementStoreLike | null) {
  onMount(async () => {
    if (!wl || achievementsStarted)
      return
    // As with follows: wait for the session to say whose wall this is, or the
    // first load fetched user 0 and never tried again.
    await initializeAuthSession()
    const userId = wl.currentUserId()
    if (achievementsStarted || userId <= 0)
      return
    achievementsStarted = true
    const payload = await fetchAchievements(userId)
    const rows = Array.isArray(payload?.achievements) ? payload.achievements : []
    if (!payload) {
      // The request itself failed; leave whatever the store already had.
      return
    }
    wl.hydrateAchievements(rows.map((a: any) => ({
      id: a.id,
      name: a.name,
      description: a.description,
      icon: a.icon,
      progress: a.progress ?? 0,
      total: a.target ?? 1,
      unlockedAt: a.unlockedAt ?? null,
    })))
    achievementSource.set('api')
  })
}

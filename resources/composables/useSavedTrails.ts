import { onMount } from 'stx'
import { initializeAuthSession, isSignedIn } from '../assets/scripts/auth'
import { fetchSavedTrails, toggleSaveTrail } from '../assets/scripts/game-api'
import { requireAuth } from './useAuthGate'

/**
 * Saved trails (#969): hydrate the current user's bookmarks into the `wl`
 * store once per session, and expose an optimistic save/unsave toggle the
 * trail cards + detail page share.
 */

interface SavedTrailStoreLike {
  currentUserId: () => number
  hydrateSavedTrails: (ids: number[]) => void
  isTrailSaved: (trailId: number) => boolean
  setTrailSaved: (trailId: number, saved: boolean) => void
}

let savedTrailsStarted = false

export function useSavedTrails(wl: SavedTrailStoreLike | null) {
  onMount(async () => {
    // A signed-out visitor has no bookmarks to hydrate, and asking for them
    // costs a request that comes back 401.
    if (!wl || savedTrailsStarted || !isSignedIn())
      return
    // Wait for the session to name the athlete. On a first load the id is
    // still 0 here, which skipped the request and marked it done, so saved
    // trails never loaded until the next page.
    await initializeAuthSession()
    const userId = wl.currentUserId()
    if (savedTrailsStarted || userId <= 0)
      return
    savedTrailsStarted = true
    const payload = await fetchSavedTrails(userId)
    if (payload && Array.isArray(payload.savedTrails))
      wl.hydrateSavedTrails(payload.savedTrails.map((s: any) => s.trailId))
  })

  async function onToggleSave(trailId: number) {
    if (!wl)
      return

    // Signed out, the write is refused and the optimistic heart snaps back —
    // which looked like a dead button. Ask first, then finish the job.
    if (!requireAuth('Save trails to your list and pick them up on any device.', () => { void onToggleSave(trailId) }))
      return

    const was = wl.isTrailSaved(trailId)
    wl.setTrailSaved(trailId, !was) // optimistic
    const res = await toggleSaveTrail(trailId, !was)
    if (res && res.success)
      wl.setTrailSaved(trailId, !!res.saved)
    else
      wl.setTrailSaved(trailId, was) // rollback
  }

  return { onToggleSave }
}

import { onMount } from 'stx'
import { initializeAuthSession, isSignedIn } from '../assets/scripts/auth'
import { fetchSavedTrails, toggleSaveTrail } from '../assets/scripts/game-api'
import { requireAuth } from './useAuthGate'
import { indexInSpotlight, removeFromSpotlight, syncSpotlight } from './useSpotlightIndex'

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
    if (payload && Array.isArray(payload.savedTrails)) {
      wl.hydrateSavedTrails(payload.savedTrails.map((s: any) => s.trailId))

      // The same list, offered to iOS Spotlight so a saved trail is findable
      // from the home screen. Newest-saved first, which is the order the API
      // returns and the order the index keeps when there are more saved trails
      // than slots. A no-op everywhere but a native build.
      void syncSpotlight('trail', payload.savedTrails.map((s: any) => ({
        id: s.trailId,
        name: s.trail?.name,
      })))
    }
  })

  /**
   * Save or unsave a trail.
   *
   * `name` is optional and only for the device's Spotlight index, which shows
   * it: every caller has the trail in scope, and one that does not still
   * saves — the next launch's sync reads the name from the API.
   */
  async function onToggleSave(trailId: number, name?: string) {
    if (!wl)
      return

    // Signed out, the write is refused and the optimistic heart snaps back —
    // which looked like a dead button. Ask first, then finish the job.
    if (!requireAuth('Save trails to your list and pick them up on any device.', () => { void onToggleSave(trailId, name) }))
      return

    const was = wl.isTrailSaved(trailId)
    wl.setTrailSaved(trailId, !was) // optimistic
    const res = await toggleSaveTrail(trailId, !was)
    if (res && res.success) {
      wl.setTrailSaved(trailId, !!res.saved)

      // Follow the heart on the device too: a saved trail is findable in
      // Spotlight, and an unsaved one stops being. Without a name there is
      // nothing worth donating — an entry reading "Trail #123" is not what
      // anybody searches for — so that one waits for the next launch's sync.
      if (!res.saved)
        void removeFromSpotlight('trail', trailId)
      else if (name)
        void indexInSpotlight('trail', { id: trailId, name })
    }
    else {
      wl.setTrailSaved(trailId, was) // rollback
    }
  }

  return { onToggleSave }
}

import { onDestroy, onMount } from 'stx'
import { apiFetch } from '../assets/scripts/auth'

interface BattleStoreLike {
  hydrateConquestsFromApi: (battles: unknown[]) => void
  hydrateMyConquestsFromApi?: (battles: unknown[]) => void
  currentUserId?: () => number
}

export function useBattleFeed(wl: BattleStoreLike | null) {
  let timer: ReturnType<typeof setInterval> | null = null
  const load = async () => {
    if (!wl) return
    const response = await apiFetch('/api/territories/battles?limit=200', {
    }).catch(() => null)
    const payload = await response?.json().catch(() => null)
    if (response?.ok && Array.isArray(payload?.battles))
      wl.hydrateConquestsFromApi(payload.battles)

    // The signed-in player's own battles, all of them, for their record. The
    // feed above is the newest 200 in the whole game, which once the game is
    // busy holds a few of anyone's.
    if ((wl.currentUserId?.() ?? 0) > 0 && wl.hydrateMyConquestsFromApi) {
      const own = await apiFetch('/api/territories/battles?mine=1&limit=1000').catch(() => null)
      const ownPayload = await own?.json().catch(() => null)
      if (own?.ok && Array.isArray(ownPayload?.battles))
        wl.hydrateMyConquestsFromApi(ownPayload.battles)
    }
  }
  onMount(() => {
    void load()
    timer = setInterval(() => void load(), 15000)
  })
  onDestroy(() => {
    if (timer) clearInterval(timer)
  })
}

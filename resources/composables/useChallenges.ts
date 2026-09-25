import { onMount, state } from 'stx'
import { createChallenge, fetchChallenges, respondToChallenge } from '../assets/scripts/game-api'

/**
 * Challenges (#965): hydrate the user's challenges from the API, drive the
 * "new challenge" form (pick a rival territory), and accept/decline received
 * ones. The API returns camelCase; the store/template use a mixed snake+camel
 * shape, so we map at the boundary.
 */

interface ChallengeStoreLike {
  currentUserId: () => number
  territories: () => any[]
  hydrateChallenges: (list: any[]) => void
  upsertChallenge: (c: any) => void
}

/** Map an API challenge (camelCase) to the store/template shape. */
function toStore(c: any): any {
  return {
    id: c.id,
    challenger_id: c.challengerId,
    challengerName: c.challengerName,
    challengerAvatar: c.challengerAvatar ?? null,
    challenged_id: c.challengedId,
    challengedName: c.challengedName,
    challengedAvatar: c.challengedAvatar ?? null,
    territory_id: c.territoryId,
    territoryName: c.territoryName,
    status: c.status,
    winner_id: c.winnerId ?? undefined,
    areaAtStake: c.areaAtStake,
    deadline: c.deadline,
    created_at: c.createdAt,
  }
}

let challengesStarted = false

export function useChallenges(wl: ChallengeStoreLike | null) {
  const createOpen = state(false)
  const submitting = state(false)
  const createError = state<string | null>(null)
  const targetTerritoryId = state('')
  const busyId = state<number | null>(null)

  onMount(async () => {
    if (!wl || challengesStarted)
      return
    challengesStarted = true
    const rows = await fetchChallenges()
    if (rows)
      wl.hydrateChallenges(rows.map(toStore))
  })

  // Rival territories you could challenge for (not your own).
  function rivalTerritories(): any[] {
    if (!wl)
      return []
    const me = wl.currentUserId()
    return wl.territories().filter((t: any) => t.user_id !== me)
  }

  function openCreate() {
    const rivals = rivalTerritories()
    targetTerritoryId.set(rivals.length ? String(rivals[0].id) : '')
    createError.set(null)
    createOpen.set(true)
  }

  function closeCreate() {
    createOpen.set(false)
    createError.set(null)
  }

  async function submitCreate() {
    if (!wl || submitting())
      return
    const territoryId = Number(targetTerritoryId())
    if (!Number.isFinite(territoryId) || territoryId <= 0) {
      createError.set('Pick a territory to challenge for.')
      return
    }
    submitting.set(true)
    createError.set(null)
    const res = await createChallenge(territoryId)
    submitting.set(false)
    if (res && res.success && res.challenge) {
      wl.upsertChallenge(toStore(res.challenge))
      createOpen.set(false)
    }
    else {
      createError.set(res?.fields ? Object.values(res.fields)[0] as string : (res?.error ?? 'Could not create the challenge.'))
    }
  }

  async function respond(challenge: any, action: 'accept' | 'decline') {
    if (!wl || busyId() !== null)
      return
    busyId.set(challenge.id)
    const res = await respondToChallenge(challenge.id, action)
    busyId.set(null)
    if (res && res.success && res.challenge)
      wl.upsertChallenge(toStore(res.challenge))
  }

  return {
    createOpen,
    submitting,
    createError,
    targetTerritoryId,
    busyId,
    rivalTerritories,
    openCreate,
    closeCreate,
    submitCreate,
    respond,
  }
}

import { onMount, state } from 'stx'
import { createClub, fetchClubs, toggleClubMembership } from '../assets/scripts/game-api'
import { requireAuth } from './useAuthGate'

/**
 * Clubs (#964): hydrate the club list from the API, toggle membership
 * optimistically, and drive the create-club form.
 */

interface ClubStoreLike {
  currentUserId: () => number
  clubs: () => any[]
  hydrateClubs: (list: any[]) => void
  addClub: (club: any) => void
  applyClubMembership: (clubId: number, joined: boolean, memberCount: number) => void
}

const CLUB_TYPES = ['Running', 'Hiking', 'Mixed', 'Territory Game']
// `as const` so the array is a tuple of literals, which makes JoinPolicy a real
// union rather than `string` — the form signal below is typed from it, so a
// policy the API does not accept cannot be assigned in the first place.
const JOIN_POLICIES = ['open', 'invite_only'] as const
type JoinPolicy = typeof JOIN_POLICIES[number]

let clubsStarted = false

export function useClubs(wl: ClubStoreLike | null) {
  const createOpen = state(false)
  const submitting = state(false)
  const createError = state<string | null>(null)

  const fName = state('')
  const fType = state('Running')
  const fLocation = state('')
  const fDescription = state('')
  const fPrivate = state(false)
  const fJoinPolicy = state<JoinPolicy>('open')

  onMount(async () => {
    if (!wl || clubsStarted)
      return
    clubsStarted = true
    const clubs = await fetchClubs()
    if (clubs)
      wl.hydrateClubs(clubs)
  })

  function isMember(club: any): boolean {
    if (!wl)
      return false
    return club.isMember ?? (club.members ?? []).includes(wl.currentUserId())
  }

  async function onToggleMembership(club: any) {
    if (!wl)
      return

    // Joining writes a membership row against the signed-in user, so ask
    // before the optimistic count moves.
    if (!requireAuth('Join a club to train with its crew.', () => { void onToggleMembership(club) }))
      return

    const club2 = wl.clubs().find(c => c.id === club.id) ?? club
    const was = isMember(club2)
    // Capture the ORIGINAL count before the optimistic mutation - applyClub-
    // Membership mutates club2.memberCount in place, so reading it again on
    // failure would roll back to the optimistic value, not the original.
    const prevCount = club2.memberCount ?? 0
    const nextCount = prevCount + (was ? -1 : 1)
    wl.applyClubMembership(club.id, !was, nextCount) // optimistic
    const res = await toggleClubMembership(club.id)
    if (res && res.success)
      wl.applyClubMembership(club.id, !!res.joined, res.memberCount ?? nextCount)
    else
      wl.applyClubMembership(club.id, was, prevCount) // rollback to original
  }

  function openCreate() {
    if (!requireAuth('Create a club to bring your crew onto WildLoop.', () => openCreate()))
      return

    fName.set('')
    fType.set('Running')
    fLocation.set('')
    fDescription.set('')
    fPrivate.set(false)
    fJoinPolicy.set('open')
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
    const name = fName().trim()
    if (name.length < 2) {
      createError.set('Give your club a name (at least 2 characters).')
      return
    }
    if (!CLUB_TYPES.includes(fType())) {
      createError.set('Pick a club type.')
      return
    }
    if (!JOIN_POLICIES.includes(fJoinPolicy() as JoinPolicy)) {
      createError.set('Pick who can join.')
      return
    }
    submitting.set(true)
    createError.set(null)
    const res = await createClub({
      name,
      club_type: fType(),
      location: fLocation().trim() || null,
      description: fDescription().trim() || null,
      is_private: fPrivate(),
      join_policy: fJoinPolicy(),
    })
    submitting.set(false)
    if (res && res.success && res.club) {
      wl.addClub(res.club)
      createOpen.set(false)
    }
    else {
      createError.set(res?.fields ? Object.values(res.fields)[0] as string : (res?.error ?? 'Could not create the club.'))
    }
  }

  return {
    createOpen,
    submitting,
    createError,
    fName,
    fType,
    fLocation,
    fDescription,
    fPrivate,
    fJoinPolicy,
    isMember,
    onToggleMembership,
    openCreate,
    closeCreate,
    submitCreate,
  }
}

// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// POST /api/clubs/{id}/invites (auth, owner/admin) - invite somebody into a
// closed club.
//
// An invite names either an athlete already on Wildloop or an email address
// that is not yet an account. The redeemable code works either way, so an
// invite link survives the recipient signing up after they receive it.

import { Auth } from '@stacksjs/auth'

const INVITE_TTL_DAYS = 30

export default new Action({
  name: 'Club Invite Store',
  description: 'Invite an athlete to a club',
  method: 'POST',

  async handle(request) {
    const clubId = positiveInt(request.get('id') ?? request.get('club_id'))
    const userId = (await Auth.user().catch(() => null))?.id

    if (!userId)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!clubId)
      return response.json({ success: false, error: 'Validation failed', fields: { id: 'required: a positive integer club id' } }, 422)

    try {
      const club = await Club.find(clubId)
      if (!club)
        return response.json({ success: false, error: 'Club not found' }, 404)

      const membership = await ClubMember
        .where('club_id', '=', clubId)
        .where('user_id', '=', userId)
        .first()
      if (!membership || (membership.role !== 'owner' && membership.role !== 'admin'))
        return response.json({ success: false, error: 'Only owners and admins can invite' }, 403)

      const email = normalizeEmail(request.get('email'))
      let invitedUserId = positiveInt(request.get('user_id') ?? request.get('userId'))

      // An email that already belongs to an account is an invite to that
      // account, not a dangling address. Resolving it here is what lets the
      // recipient see the invite in the app instead of only in their inbox.
      if (!invitedUserId && email) {
        const existingUser = await User.where('email', '=', email).first().catch(() => null)
        if (existingUser)
          invitedUserId = existingUser.id
      }

      if (!invitedUserId && !email)
        return response.json({ success: false, error: 'Validation failed', fields: { email: 'required: an email address or a user id' } }, 422)

      if (invitedUserId) {
        const already = await ClubMember
          .where('club_id', '=', clubId)
          .where('user_id', '=', invitedUserId)
          .first()
        if (already)
          return response.json({ success: false, error: 'They are already a member' }, 409)

        const pending = await ClubInvite
          .where('club_id', '=', clubId)
          .where('invited_user_id', '=', invitedUserId)
          .where('status', '=', 'pending')
          .first()
        // Re-inviting somebody should hand back the invite that already
        // exists, not mint a second code that quietly invalidates the link
        // they were sent yesterday.
        if (pending)
          return response.json({ success: true, invite: present(pending, club), reused: true })
      }

      const expires = new Date(Date.now() + INVITE_TTL_DAYS * 86400000).toISOString()
      const invite = await ClubInvite.forceCreate({
        club_id: clubId,
        invited_by_id: userId,
        invited_user_id: invitedUserId ?? null,
        invited_email: email,
        code: mintCode(),
        status: 'pending',
        expires_at: expires,
        note: boundedString(request.get('note'), 300) ?? null,
      })

      return response.json({ success: true, invite: present(invite, club), reused: false }, 201)
    }
    catch (error) {
      console.error('[clubs] invite store failed:', error)
      return response.json({ success: false, error: 'Failed to create the invite' }, 500)
    }
  },
})

function present(invite: any, club: any) {
  return {
    id: invite.id,
    clubId: invite.club_id,
    clubName: club?.name ?? null,
    code: invite.code,
    status: invite.status,
    invitedUserId: invite.invited_user_id,
    invitedEmail: invite.invited_email,
    note: invite.note,
    expiresAt: invite.expires_at,
    createdAt: invite.created_at,
  }
}

function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string')
    return null
  const value = raw.trim().toLowerCase()
  if (!value || value.length > 200)
    return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null
}

/**
 * A code that cannot be guessed.
 *
 * An invite code IS the credential for a closed club, so it comes from the
 * platform CSPRNG rather than Math.random. Base32 without the characters that
 * get misread aloud, because these get read over the phone at trailheads.
 */
function mintCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const bytes = new Uint8Array(20)
  crypto.getRandomValues(bytes)
  let code = ''
  for (let i = 0; i < bytes.length; i++) {
    if (i > 0 && i % 5 === 0)
      code += '-'
    code += alphabet[bytes[i]! % alphabet.length]
  }
  return code
}

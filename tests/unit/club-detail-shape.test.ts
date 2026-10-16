import { describe, expect, it } from 'bun:test'
import {
  canDeleteClub,
  clubApiPath,
  canInviteToClub,
  clubDeleteRequest,
  clubDetailFrom,
  clubInvitesPath,
  clubRedeemPath,
  clubRoleOf,
  clubWeeklyActivitiesText,
  clubWeeklyDistanceText,
  inviteLine,
  inviteRowsFrom,
  inviteStatusText,
  isRedeemable,
  memberLine,
  memberRoleText,
  MIN_INVITE_CODE,
} from '../../resources/functions/clubs'

/**
 * One club's own page, added when `/club/:id` was promoted.
 *
 * The permissions are the point. Who may invite comes off the membership
 * roster and who may delete comes off `creatorId` — not from `isMember`, and
 * not from a role alone. A screen that guessed either would offer a control
 * the API refuses.
 */

const ME = 12

function detail(over: Record<string, unknown> = {}) {
  return {
    club: {
      id: 2,
      name: 'Dawn Patrol',
      type: 'Running',
      location: 'San Diego, CA',
      description: 'Before work, every day.',
      memberCount: 48,
      joinPolicy: 'open',
      creatorId: 44,
      isMember: false,
      weeklyDistance: 184.6,
      activitiesThisWeek: 37,
      members: [
        { userId: 44, name: 'Marta Keller', role: 'owner' },
        { userId: 90, name: 'Rui Alves', role: 'admin' },
        { userId: ME, name: 'Glenn', role: 'member' },
      ],
      leaderboard: [{ rank: 1, name: 'Marta Keller', weeklyDistance: 52.1 }],
      recentFeed: [],
      ...over,
    },
  }
}

describe('clubDetailFrom', () => {
  it('reads the club out of the envelope', () => {
    expect(clubDetailFrom(detail())?.name).toBe('Dawn Patrol')
  })

  it('answers nothing for a payload with no club', () => {
    for (const payload of [null, undefined, {}, { club: null }, { club: {} }, 'nope'])
      expect(clubDetailFrom(payload)).toBeNull()
  })
})

describe('the club endpoints', () => {
  it('names the invites and the delete', () => {
    expect(clubInvitesPath(2)).toBe('/api/clubs/2/invites')
    expect(clubDeleteRequest(2)).toEqual({ path: '/api/clubs/2', method: 'DELETE' })
  })

  /*
   * `clubApiPath` and `clubPath` are different things and the names do not say
   * so loudly enough: the latter is the *web page*. Building the invites path
   * on it produced `/club/2/invites`, which is not an endpoint.
   */
  it('keeps the API path apart from the page path', () => {
    expect(clubApiPath(2)).toBe('/api/clubs/2')
    expect(clubInvitesPath(2)).toStartWith('/api/')
    expect(clubDeleteRequest(2).path).toStartWith('/api/')
  })

  /* Redeeming is club-agnostic: the code says which club it is for. */
  it('redeems without naming a club', () => {
    expect(clubRedeemPath()).toBe('/api/clubs/invites/accept')
    expect(clubRedeemPath()).not.toContain('2')
  })
})

describe('clubRoleOf', () => {
  const club = clubDetailFrom(detail())

  it('reads the viewer\'s own role off the roster', () => {
    expect(clubRoleOf(club, ME)).toBe('member')
    expect(clubRoleOf(club, 44)).toBe('owner')
    expect(clubRoleOf(club, 90)).toBe('admin')
  })

  it('gives nobody a role', () => {
    expect(clubRoleOf(club, 999)).toBeNull()
    expect(clubRoleOf(club, null)).toBeNull()
    expect(clubRoleOf(club, 0)).toBeNull()
    expect(clubRoleOf(null, ME)).toBeNull()
  })

  it('refuses a role the API does not define', () => {
    const odd = clubDetailFrom(detail({ members: [{ userId: ME, name: 'Glenn', role: 'overlord' }] }))

    expect(clubRoleOf(odd, ME)).toBeNull()
  })
})

describe('who may do what', () => {
  const club = clubDetailFrom(detail())

  /*
   * Off the roster, not off `isMember`. A plain member shown an invite form is
   * being offered something the API refuses.
   */
  it('lets an owner and an admin invite, and nobody else', () => {
    expect(canInviteToClub(club, 44)).toBe(true)
    expect(canInviteToClub(club, 90)).toBe(true)
    expect(canInviteToClub(club, ME)).toBe(false)
    expect(canInviteToClub(club, 999)).toBe(false)
  })

  /*
   * Deleting is the creator's alone. An admin has a role that sounds like it
   * should be enough and is not.
   */
  it('lets only the creator delete, never an admin', () => {
    expect(canDeleteClub(club, 44)).toBe(true)
    expect(canDeleteClub(club, 90)).toBe(false)
    expect(canDeleteClub(club, ME)).toBe(false)
    expect(canDeleteClub(club, null)).toBe(false)
  })

  it('gives a signed-out viewer nothing', () => {
    expect(canInviteToClub(club, 0)).toBe(false)
    expect(canDeleteClub(club, 0)).toBe(false)
  })
})

describe('isRedeemable', () => {
  /*
   * Held to eight characters before anything is sent, so a half-typed code is
   * "finish typing" rather than "that code did not work" from the server.
   */
  it('holds out for a whole code', () => {
    expect(MIN_INVITE_CODE).toBe(8)
    expect(isRedeemable('ABCD1234')).toBe(true)
    expect(isRedeemable('  ABCD1234  ')).toBe(true)
    expect(isRedeemable('ABC')).toBe(false)
    expect(isRedeemable('')).toBe(false)
    expect(isRedeemable('   ')).toBe(false)
  })

  it('refuses anything that is not a string', () => {
    for (const raw of [null, undefined, 12_345_678, {}, []])
      expect(isRedeemable(raw)).toBe(false)
  })
})

describe('the invites', () => {
  const payload = {
    invites: [
      { id: 1, code: 'AAAA1111', status: 'pending', invitedEmail: 'a@example.com', invitedName: null, createdAt: '2026-10-14T07:00:00.000Z' },
      { id: 2, code: 'BBBB2222', status: 'accepted', invitedEmail: null, invitedName: 'Rui Alves', createdAt: '2026-10-16T07:00:00.000Z' },
      { id: 3, code: 'CCCC3333', status: 'pending', invitedEmail: null, invitedName: null, createdAt: '2026-10-15T07:00:00.000Z' },
    ],
  }

  it('puts the newest first', () => {
    expect(inviteRowsFrom(payload).map(invite => invite.id)).toEqual([2, 3, 1])
  })

  it('names who it is for, or says it is open', () => {
    const rows = inviteRowsFrom(payload)

    expect(inviteLine(rows.find(r => r.id === 2))).toBe('Rui Alves')
    expect(inviteLine(rows.find(r => r.id === 1))).toBe('a@example.com')
    expect(inviteLine(rows.find(r => r.id === 3))).toBe('Open invite')
  })

  it('reads its status', () => {
    expect(inviteStatusText({ status: 'revoked' })).toBe('revoked')
    expect(inviteStatusText({})).toBe('pending')
  })

  it('survives a payload that is not what it should be', () => {
    for (const bad of [null, undefined, {}, { invites: 'nope' }, { invites: [null, {}] }])
      expect(inviteRowsFrom(bad)).toEqual([])
  })
})

describe('the members and the week', () => {
  const club = clubDetailFrom(detail())

  it('names a member and capitalises their role', () => {
    expect(memberLine(club.members[0])).toBe('Marta Keller')
    expect(memberRoleText(club.members[0])).toBe('Owner')
    expect(memberRoleText(club.members[2])).toBe('Member')
  })

  it('reads a member with nothing on them', () => {
    expect(memberLine(null)).toBe('Member')
    expect(memberRoleText(null)).toBe('Member')
  })

  it('reads the week', () => {
    expect(clubWeeklyDistanceText(club)).toBe('184.6 mi')
    expect(clubWeeklyActivitiesText(club)).toBe('37')
  })

  it('reads zero rather than throwing before anything loads', () => {
    expect(clubWeeklyDistanceText(null)).toBe('0.0 mi')
    expect(clubWeeklyActivitiesText(null)).toBe('0')
  })
})

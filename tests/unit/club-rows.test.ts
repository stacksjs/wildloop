import { describe, expect, it } from 'bun:test'
import {
  CLUB_FILTERS,
  clubActionLabel,
  clubDoorLabel,
  clubJoinRequest,
  clubMemberText,
  clubPath,
  clubPlaceLine,
  clubRowsFrom,
  clubsPath,
  clubWeekLine,
  filterClubs,
  isClubMember,
  matchesClubFilter,
} from '../../resources/functions/clubs'

/**
 * The club directory, as both screens compute it.
 *
 * Extracted from `resources/views/clubs.stx` and `useClubs` when the native
 * screen became the second consumer. Membership is the part that matters: the
 * listing withholds the roster and sends a boolean, and a screen reading only
 * the roster offers to join a club somebody is already in.
 */

const ROWS = {
  clubs: [
    { id: 1, name: 'Queen City Trail Club', description: 'Tuesday nights.', location: 'Cincinnati, OH', type: 'Running', isPrivate: false, joinPolicy: 'open', memberCount: 48, isMember: false, weeklyDistance: 312, activitiesThisWeek: 27 },
    { id: 2, name: 'Alpenverein Munich', description: 'Weekend ridges.', location: 'Munich, Bayern', type: 'Hiking', isPrivate: false, joinPolicy: 'request', memberCount: 1, isMember: true, weeklyDistance: 0, activitiesThisWeek: 0 },
    { id: 3, name: 'Gorge Land Grab', description: 'Loops only.', location: 'Portland, OR', type: 'Territory Game', isPrivate: true, joinPolicy: 'invite_only', memberCount: 9, isMember: false, weeklyDistance: 64, activitiesThisWeek: 1 },
  ],
}

describe('clubRowsFrom', () => {
  it('maps the listing, coercing what the API sends loosely', () => {
    const rows = clubRowsFrom({ clubs: [{ id: '4', name: 'Night Owls', memberCount: '12', weeklyDistance: '40.6' }] })

    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(4)
    expect(rows[0].memberCount).toBe(12)
    expect(rows[0].weeklyDistance).toBe(41)
  })

  it('takes a bare array as well as the wrapped payload', () => {
    expect(clubRowsFrom(ROWS.clubs)).toHaveLength(3)
    expect(clubRowsFrom(ROWS)).toHaveLength(3)
  })

  it('never leaves a club without a name', () => {
    expect(clubRowsFrom({ clubs: [{ id: 5 }] })[0].name).toBe('Unnamed club')
  })

  it('drops a row with no id rather than rendering a dead link', () => {
    expect(clubRowsFrom({ clubs: [{ name: 'Ghost crew' }] })).toEqual([])
  })

  it('survives a payload that is not what it should be', () => {
    for (const payload of [null, undefined, {}, 'nope', { clubs: 'nope' }])
      expect(clubRowsFrom(payload)).toEqual([])
  })

  it('reads an unknown join policy as open, not as a locked door', () => {
    expect(clubRowsFrom({ clubs: [{ id: 6, joinPolicy: 'whatever' }] })[0].joinPolicy).toBe('open')
  })
})

describe('isClubMember', () => {
  it('believes the boolean the listing sends', () => {
    expect(isClubMember({ isMember: true })).toBe(true)
    expect(isClubMember({ isMember: false }, 12)).toBe(false)
  })

  it('falls back to the roster an older payload carried', () => {
    expect(isClubMember({ members: [4, 12, 30] }, 12)).toBe(true)
    expect(isClubMember({ members: [4, 30] }, 12)).toBe(false)
  })

  it('says no when it cannot tell, rather than throwing', () => {
    expect(isClubMember(null)).toBe(false)
    expect(isClubMember({})).toBe(false)
    expect(isClubMember({ members: [12] })).toBe(false)
  })
})

describe('the filters', () => {
  const rows = clubRowsFrom(ROWS)

  it('offers every kind plus all and mine, in the order the chips read', () => {
    expect([...CLUB_FILTERS]).toEqual(['all', 'mine', 'Running', 'Hiking', 'Territory Game'])
  })

  it('keeps everything under all', () => {
    expect(filterClubs(rows, 'all')).toHaveLength(3)
  })

  it('reads mine as membership, not as ownership', () => {
    expect(filterClubs(rows, 'mine').map(c => c.id)).toEqual([2])
  })

  it('matches a kind exactly', () => {
    expect(filterClubs(rows, 'Territory Game').map(c => c.id)).toEqual([3])
    expect(matchesClubFilter(rows[0], 'Hiking')).toBe(false)
  })
})

describe('how a row reads', () => {
  const rows = clubRowsFrom(ROWS)

  it('counts members without the limp plural', () => {
    expect(clubMemberText(48)).toBe('48 members')
    expect(clubMemberText(1)).toBe('1 member')
    expect(clubMemberText(0)).toBe('0 members')
  })

  it('puts the place and the kind on one line, and skips a missing half', () => {
    expect(clubPlaceLine(rows[0])).toBe('Cincinnati, OH · Running')
    expect(clubPlaceLine({ location: '', type: 'Running' })).toBe('Running')
    expect(clubPlaceLine({})).toBe('')
  })

  it('reports the week, and says plainly when there was not one', () => {
    expect(clubWeekLine(rows[0])).toBe('312 mi · 27 activities this week')
    expect(clubWeekLine(rows[2])).toBe('64 mi · 1 activity this week')
    expect(clubWeekLine(rows[1])).toBe('Quiet week')
  })

  it('names the door only where the button has not already said it', () => {
    expect(clubDoorLabel(rows[0])).toBe('')
    expect(clubDoorLabel(rows[1])).toBe('Ask to join')
    expect(clubDoorLabel(rows[2])).toBe('Invite only')
    expect(clubDoorLabel({ isPrivate: true, joinPolicy: 'open' })).toBe('Members only')
  })
})

describe('clubActionLabel', () => {
  const rows = clubRowsFrom(ROWS)

  it('offers to leave a club the viewer is in', () => {
    expect(clubActionLabel(rows[1])).toBe('Leave')
  })

  it('offers to join an open one, and to ask at a club that asks', () => {
    expect(clubActionLabel(rows[0])).toBe('Join')
    expect(clubActionLabel({ joinPolicy: 'request', isMember: false })).toBe('Ask to join')
  })

  /*
   * An invite-only club cannot be joined from a list at all, so the control
   * sends the viewer to the club's page rather than offering a button that
   * will be refused.
   */
  it('sends an outsider to the page of an invite-only club', () => {
    expect(clubActionLabel(rows[2])).toBe('View')
  })

  it('still lets a member of an invite-only club leave it', () => {
    expect(clubActionLabel({ joinPolicy: 'invite_only', isMember: true })).toBe('Leave')
  })
})

describe('the endpoints', () => {
  it('reads the public directory', () => {
    expect(clubsPath()).toBe('/api/clubs')
  })

  it('joins and leaves through the one endpoint the server decides', () => {
    expect(clubJoinRequest(7)).toEqual({ path: '/api/clubs/7/join', method: 'POST' })
  })

  it('points at the club\'s own page', () => {
    expect(clubPath(7)).toBe('/club/7')
  })
})

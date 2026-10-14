import { describe, expect, it } from 'bun:test'
import {
  CHALLENGE_TABS,
  canRespondToChallenge,
  challengeEmptyText,
  challengeRespondRequest,
  challengeRowsFrom,
  challengesPath,
  challengeStakeText,
  challengeStatusText,
  challengeVersusLine,
  challengeWaitingText,
  filterChallenges,
  territoryPath,
} from '../../resources/functions/challenges'

/**
 * Challenges, as both screens compute them.
 *
 * Added to the module the Challenge actions already share when `/challenges`
 * was promoted to a native screen. Everything here depends on which side of
 * the challenge the viewer is on, which is the part worth pinning: "completed"
 * is the same word for both people and only one of them won.
 */

const ME = 12

const ROWS = {
  challenges: [
    { id: 1, challengerId: ME, challengerName: 'Glenn', challengedId: 30, challengedName: 'Marta Keller', territoryId: 7, territoryName: 'Hirschgarten', status: 'pending', winnerId: null, areaAtStake: 248000, createdAt: '2026-10-12T08:00:00.000Z' },
    { id: 2, challengerId: 30, challengerName: 'Marta Keller', challengedId: ME, challengedName: 'Glenn', territoryId: 9, territoryName: 'Englischer Garten', status: 'pending', winnerId: null, areaAtStake: 1_450_000, createdAt: '2026-10-13T08:00:00.000Z' },
    { id: 3, challengerId: ME, challengerName: 'Glenn', challengedId: 44, challengedName: 'Tom Byrne', territoryId: 4, territoryName: 'Isarauen', status: 'completed', winnerId: ME, areaAtStake: 9000, createdAt: '2026-10-01T08:00:00.000Z' },
    { id: 4, challengerId: 44, challengerName: 'Tom Byrne', challengedId: ME, challengedName: 'Glenn', territoryId: 5, territoryName: 'Olympiapark', status: 'completed', winnerId: 44, areaAtStake: 62000, createdAt: '2026-09-28T08:00:00.000Z' },
    { id: 5, challengerId: 30, challengerName: 'Marta Keller', challengedId: ME, challengedName: 'Glenn', territoryId: 6, territoryName: 'Westpark', status: 'active', winnerId: null, areaAtStake: 310000, createdAt: '2026-10-14T08:00:00.000Z' },
  ],
}

describe('challengeRowsFrom', () => {
  it('reads the camelCase the API answers in', () => {
    const rows = challengeRowsFrom(ROWS)

    expect(rows).toHaveLength(5)
    expect(rows[0].challengerId).toBe(ME)
    expect(rows[0].territoryName).toBe('Hirschgarten')
  })

  /*
   * The API answers camelCase and the web store keeps a snake_case copy. A
   * screen reading only one of them reads half the rows as belonging to
   * nobody, which is how a challenge ends up showing two strangers.
   */
  it('reads the snake_case the web store keeps too', () => {
    const [row] = challengeRowsFrom({
      challenges: [{ id: 8, challenger_id: 12, challenged_id: 30, territory_id: 7, winner_id: 12, area_at_stake: 500, created_at: '2026-10-12T08:00:00.000Z' }],
    })

    expect(row.challengerId).toBe(12)
    expect(row.challengedId).toBe(30)
    expect(row.territoryId).toBe(7)
    expect(row.winnerId).toBe(12)
    expect(row.areaAtStake).toBe(500)
  })

  it('takes a bare array as well as the wrapped payload', () => {
    expect(challengeRowsFrom(ROWS.challenges)).toHaveLength(5)
  })

  it('keeps an unfinished challenge\'s winner as null, not as nobody with id zero', () => {
    expect(challengeRowsFrom(ROWS)[0].winnerId).toBeNull()
    expect(challengeRowsFrom(ROWS)[2].winnerId).toBe(ME)
  })

  it('reads an unknown status as pending, which is the one that asks for nothing', () => {
    expect(challengeRowsFrom({ challenges: [{ id: 9, status: 'whatever' }] })[0].status).toBe('pending')
  })

  it('never carries a negative stake', () => {
    expect(challengeRowsFrom({ challenges: [{ id: 9, areaAtStake: -4000 }] })[0].areaAtStake).toBe(0)
  })

  it('survives a payload that is not what it should be', () => {
    for (const payload of [null, undefined, {}, 'nope', { challenges: 'nope' }])
      expect(challengeRowsFrom(payload)).toEqual([])
  })
})

describe('the tabs', () => {
  const rows = challengeRowsFrom(ROWS)

  it('reads in the order the web page shows them', () => {
    expect([...CHALLENGE_TABS]).toEqual(['active', 'sent', 'received', 'completed'])
  })

  it('counts both pending and running as active', () => {
    expect(filterChallenges(rows, 'active', ME).map(r => r.id)).toEqual([1, 2, 5])
  })

  it('splits sent from received by which side the viewer is on', () => {
    expect(filterChallenges(rows, 'sent', ME).map(r => r.id)).toEqual([1, 3])
    expect(filterChallenges(rows, 'received', ME).map(r => r.id)).toEqual([2, 4, 5])
  })

  it('keeps only finished ones under completed, won or lost alike', () => {
    expect(filterChallenges(rows, 'completed', ME).map(r => r.id)).toEqual([3, 4])
  })

  it('names what an empty tab means, rather than showing nothing', () => {
    expect(challengeEmptyText('active')).toBe('No active challenges')
    expect(challengeEmptyText('sent')).toBe('You have not sent any')
    expect(challengeEmptyText('received')).toBe('Nobody has challenged you')
    expect(challengeEmptyText('completed')).toBe('No finished challenges yet')
  })
})

describe('challengeStatusText', () => {
  const rows = challengeRowsFrom(ROWS)

  it('says where an unfinished one stands', () => {
    expect(challengeStatusText(rows[0], ME)).toBe('Pending')
    expect(challengeStatusText(rows[4], ME)).toBe('In progress')
    expect(challengeStatusText({ status: 'declined' }, ME)).toBe('Declined')
  })

  /*
   * The same finished challenge reads Won to one person and Lost to the other.
   * "Completed" is the word that is true for both and useful to neither.
   */
  it('reads a finished challenge from the viewer\'s side', () => {
    expect(challengeStatusText(rows[2], ME)).toBe('Won')
    expect(challengeStatusText(rows[3], ME)).toBe('Lost')
    expect(challengeStatusText(rows[2], 44)).toBe('Lost')
    expect(challengeStatusText(rows[3], 44)).toBe('Won')
  })
})

describe('challengeVersusLine', () => {
  const rows = challengeRowsFrom(ROWS)

  it('puts the viewer on whichever side they are on', () => {
    expect(challengeVersusLine(rows[0], ME)).toBe('You vs Marta Keller')
    expect(challengeVersusLine(rows[1], ME)).toBe('Marta Keller vs You')
  })

  it('names both when the viewer is in neither seat', () => {
    expect(challengeVersusLine(rows[0], 99)).toBe('Glenn vs Marta Keller')
  })
})

describe('challengeStakeText', () => {
  /*
   * Square metres, copied from the territory. This was once divided by 1,000
   * and labelled km² — a thousandfold overstatement — so the unit is the
   * shared formatter's to pick, not the markup's.
   */
  it('picks the unit for the magnitude', () => {
    expect(challengeStakeText(9000)).toBe('9,000 m² at stake')
    expect(challengeStakeText(248000)).toBe('24.8 ha at stake')
    expect(challengeStakeText(1_450_000)).toBe('1.45 km² at stake')
  })

  it('treats nonsense as nothing at stake', () => {
    expect(challengeStakeText(null)).toBe('0 m² at stake')
    expect(challengeStakeText(-5)).toBe('0 m² at stake')
  })
})

describe('who may answer', () => {
  const rows = challengeRowsFrom(ROWS)

  it('lets the defender answer while it is still being asked', () => {
    expect(canRespondToChallenge(rows[1], ME)).toBe(true)
  })

  it('does not let the challenger answer their own challenge', () => {
    expect(canRespondToChallenge(rows[0], ME)).toBe(false)
  })

  it('does not reopen one that has been accepted or finished', () => {
    expect(canRespondToChallenge(rows[4], ME)).toBe(false)
    expect(canRespondToChallenge(rows[3], ME)).toBe(false)
  })

  it('tells the challenger whose answer it is waiting on', () => {
    expect(challengeWaitingText(rows[0], ME)).toBe('Waiting for Marta Keller to respond')
    expect(challengeWaitingText(rows[1], ME)).toBe('')
    expect(challengeWaitingText(rows[4], ME)).toBe('')
  })
})

describe('the endpoints', () => {
  it('reads the viewer\'s own challenges, both directions', () => {
    expect(challengesPath()).toBe('/api/challenges')
  })

  it('accepts and declines through one endpoint, told apart by the body', () => {
    expect(challengeRespondRequest(3, 'accept')).toEqual({ path: '/api/challenges/3/respond', method: 'POST', body: { action: 'accept' } })
    expect(challengeRespondRequest(3, 'decline').body).toEqual({ action: 'decline' })
  })

  it('points at the territory\'s own page, which is a map', () => {
    expect(territoryPath(7)).toBe('/territory/7')
  })
})

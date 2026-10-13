import { describe, expect, it } from 'bun:test'
import {
  LEADERBOARD_METRICS,
  LEADERBOARD_PERIODS,
  leaderboardQuery,
  leaderMetricText,
  leaderRowsFrom,
  leaderSecondaryText,
  metricPhrase,
  periodPhrase,
} from '../../resources/functions/leaderboard'

/**
 * The leaderboard's numbers and query, as both screens compute them.
 *
 * Extracted from `resources/views/leaderboard.stx` when the native screen
 * became the second consumer: a board where "this week" means two different
 * weeks is worse than no board.
 */

const ROW = {
  rank: 2,
  userId: 9,
  userName: 'Harvey Lewis',
  userAvatar: '/api/avatars/9/x.jpg',
  totalDistance: 93.5,
  totalElevation: 7880,
  trailsCompleted: 5,
}

describe('leaderboardQuery', () => {
  it('carries the three axes', () => {
    expect(leaderboardQuery({ period: 'monthly', metric: 'elevation', scope: 'global' }))
      .toBe('period=monthly&metric=elevation&scope=global')
  })

  /*
   * Two decimal places is about a kilometre: enough to find the right city,
   * not enough to find a house.
   */
  it('rounds a local board’s coordinate to the city, not the street', () => {
    const query = leaderboardQuery({
      period: 'weekly',
      metric: 'distance',
      scope: 'local',
      area: { lat: 37.726737, lng: -119.542904 },
    })

    expect(query).toContain('lat=37.73')
    expect(query).toContain('lng=-119.54')
  })

  /*
   * A local board with no fix asks for the global one rather than sending a
   * filter the API cannot honour and getting an empty list back.
   */
  it('falls back to global when there is no fix', () => {
    const query = leaderboardQuery({ period: 'weekly', metric: 'distance', scope: 'local', area: null })

    expect(query).toContain('scope=global')
    expect(query).not.toContain('lat=')
  })
})

describe('leaderRowsFrom', () => {
  it('keeps the API’s rank, and numbers the rows when it sends none', () => {
    const rows = leaderRowsFrom({ leaderboard: [{ userName: 'A' }, { userName: 'B', rank: 9 }] })

    expect(rows.map(row => row.rank)).toEqual([1, 9])
  })

  /*
   * The board aggregates anonymous activity under one "Athlete". That row has
   * no profile to open, so its id stays null rather than becoming 0 — which a
   * screen would happily turn into `/athlete/0`.
   */
  it('leaves an anonymous row without an id', () => {
    const [row] = leaderRowsFrom({ leaderboard: [{ rank: 1, userId: null, userName: 'Athlete', totalDistance: 509.46 }] })

    expect(row.userId).toBeNull()
    expect(row.userName).toBe('Athlete')
    expect(row.totalDistance).toBe(509.46)
  })

  it('returns nothing for a payload that is not a board', () => {
    expect(leaderRowsFrom(null)).toEqual([])
    expect(leaderRowsFrom({ leaderboard: 'soon' })).toEqual([])
  })
})

describe('the figures on a row', () => {
  it('shows the measure the board is ranked by', () => {
    expect(leaderMetricText(ROW, 'distance')).toBe('93.5 mi')
    expect(leaderMetricText(ROW, 'elevation')).toBe('7,880 ft')
    expect(leaderMetricText(ROW, 'activities')).toBe('5 activities')
  })

  it('counts one activity as one', () => {
    expect(leaderMetricText({ ...ROW, trailsCompleted: 1 }, 'activities')).toBe('1 activity')
  })

  /** Whichever of the two the board is not ranked by. */
  it('shows the other figure alongside', () => {
    expect(leaderSecondaryText(ROW, 'distance')).toBe('7,880 ft')
    expect(leaderSecondaryText(ROW, 'elevation')).toBe('93.5 mi')
    expect(leaderSecondaryText(ROW, 'activities')).toBe('93.5 mi')
  })

  it('says nothing about a row that is not there', () => {
    expect(leaderMetricText(undefined, 'distance')).toBe('')
    expect(leaderSecondaryText(undefined, 'distance')).toBe('')
  })
})

describe('the sentence under the title', () => {
  it('has a phrase for every period and every measure', () => {
    for (const period of LEADERBOARD_PERIODS)
      expect(periodPhrase(period), period).toMatch(/\w/)
    for (const metric of LEADERBOARD_METRICS)
      expect(metricPhrase(metric), metric).toMatch(/\w/)
  })

  it('reads as one sentence', () => {
    expect(`Who ${metricPhrase('elevation')} ${periodPhrase('alltime')}.`)
      .toBe('Who climbed the most of all time.')
  })
})

import { describe, expect, it } from 'bun:test'
import { achievementMetricValues } from '../../resources/functions/achievements'

/**
 * A track the integrity checks refused is saved to the athlete's log now
 * rather than thrown away, so the unlock engine sees it. It must not earn
 * anything: a car ride home is not a hundred-mile month or a sub-seven mile.
 */
describe('achievement metrics', () => {
  const run = { distance: 5, elevation: 400, trail_id: 1, completed_at: '2026-09-12T08:00:00Z', splits: JSON.stringify([{ mile: 1, pace: '8:10' }]) }
  const drive = {
    distance: 40,
    elevation: 3000,
    trail_id: 2,
    completed_at: '2026-09-13T08:00:00Z',
    splits: JSON.stringify([{ mile: 1, pace: '1:30' }]),
    integrity_status: 'rejected',
  }

  it('counts nothing from a refused track', () => {
    const values = achievementMetricValues({ activities: [run, drive], kudosGiven: [] })

    expect(values).toMatchObject({
      activities: 1,
      distinct_trails: 1,
      total_miles: 5,
      total_elevation: 400,
      streak_days: 1,
      fast_mile: 0,
    })
  })

  it('counts verified and unverified activities alike', () => {
    const values = achievementMetricValues({
      activities: [{ ...run, integrity_status: 'verified' }, { ...run, completed_at: '2026-09-13T08:00:00Z', integrity_status: 'unverified' }],
      kudosGiven: [],
    })

    expect(values).toMatchObject({ activities: 2, total_miles: 10, streak_days: 2 })
  })
})

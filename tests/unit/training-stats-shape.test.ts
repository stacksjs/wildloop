import { describe, expect, it } from 'bun:test'
import { barGeometry } from '../../resources/functions/bar-chart'
import {
  activityBreakdown,
  activityTypeOf,
  computeTrainingStats,
  periodStats,
  STATS_PERIODS,
  trainingActivitiesFrom,
  WEEK_CHART,
  weekBars,
} from '../../resources/functions/training-stats'

/**
 * The showing half of training stats, added when `/stats` was promoted to a
 * native screen.
 *
 * The translation is what these pin. `/api/activities` answers in camelCase
 * and `computeTrainingStats` reads snake_case, because those names came from
 * the database rows the store used to hold. An untranslated row returns zero
 * for everything — silently, and plausibly, like a quiet week.
 */

const API_ROWS = {
  activities: [
    { id: 1, userId: 12, activityType: 'Trail Run', distance: 6.2, elevationGain: 820, movingTime: '1:02:00', duration: '1:05:00', trailId: 7, calories: 640, createdAt: '2026-10-13T07:00:00.000Z' },
    { id: 2, userId: 12, activityType: 'Hike', distance: 4, elevationGain: 300, movingTime: '1:30:00', duration: '1:40:00', trailId: null, calories: null, createdAt: '2026-10-12T07:00:00.000Z' },
    { id: 3, userId: 44, activityType: 'Trail Run', distance: 99, elevationGain: 9999, movingTime: '9:00:00', duration: '9:00:00', trailId: 9, calories: 9999, createdAt: '2026-10-11T07:00:00.000Z' },
  ],
}

describe('trainingActivitiesFrom', () => {
  it('translates every field the stats maths reads', () => {
    const [row] = trainingActivitiesFrom(API_ROWS)

    expect(row.user_id).toBe(12)
    expect(row.elevation_gain).toBe(820)
    expect(row.moving_time).toBe('1:02:00')
    expect(row.trail_id).toBe(7)
    expect(row.created_at).toBe('2026-10-13T07:00:00.000Z')
  })

  /*
   * This is the whole reason the translation exists. Pass the API's rows in
   * untranslated and the athlete is told they ran nothing.
   */
  it('is what stands between the API shape and a screen of zeroes', () => {
    const translated = computeTrainingStats(12, trainingActivitiesFrom(API_ROWS))
    const raw = computeTrainingStats(12, API_ROWS.activities as any)

    expect(translated.totalDistance).toBeGreaterThan(0)
    expect(raw.totalDistance).toBe(0)
    expect(raw.totalActivities).toBe(0)
  })

  it('counts only the athlete\'s own rows', () => {
    const stats = computeTrainingStats(12, trainingActivitiesFrom(API_ROWS))

    expect(stats.totalActivities).toBe(2)
    expect(stats.totalDistance).toBe(10.2)
  })

  it('falls back to the wall clock when there is no moving time', () => {
    const [row] = trainingActivitiesFrom({ activities: [{ userId: 1, duration: '0:45:00' }] })

    expect(row.moving_time).toBe('0:45:00')
  })

  /*
   * `?? null`, not `?? 0`: the estimator returns null when it cannot
   * estimate, and zero is a claim that nothing was burned.
   */
  it('keeps an unknown calorie count as unknown', () => {
    expect(trainingActivitiesFrom(API_ROWS)[1].calories).toBeNull()
  })

  it('reads snake_case too, for anything already translated', () => {
    const [row] = trainingActivitiesFrom([{ user_id: 5, elevation_gain: 120, created_at: '2026-01-01T00:00:00.000Z' }])

    expect(row.user_id).toBe(5)
    expect(row.elevation_gain).toBe(120)
  })

  it('survives a payload that is not what it should be', () => {
    for (const payload of [null, undefined, {}, 'nope', { activities: 'nope' }])
      expect(trainingActivitiesFrom(payload)).toEqual([])
  })
})

describe('periodStats', () => {
  const stats = computeTrainingStats(12, trainingActivitiesFrom(API_ROWS))

  it('offers the three periods the web page offers', () => {
    expect([...STATS_PERIODS]).toEqual(['weekly', 'monthly', 'alltime'])
  })

  /*
   * There is no monthly activity count — `user_stats` never split one — so the
   * month borrows the all-time count. The web page does the same; saying it
   * once keeps the two from disagreeing about which number that is.
   */
  it('borrows the all-time count for the month, as the web page does', () => {
    expect(periodStats(stats, 'monthly').activities).toBe(stats.totalActivities)
    expect(periodStats(stats, 'alltime').activities).toBe(stats.totalActivities)
    expect(periodStats(stats, 'weekly').activities).toBe(stats.weeklyActivities)
  })

  it('reads zero rather than throwing before the numbers arrive', () => {
    expect(periodStats(null, 'weekly')).toEqual({ distance: 0, elevation: 0, activities: 0 })
  })
})

describe('activityBreakdown', () => {
  it('counts each kind and its share', () => {
    const rows = activityBreakdown(API_ROWS.activities)

    expect(rows.find(row => row.type === 'Trail Run')).toMatchObject({ count: 2, share: 67 })
    expect(rows.find(row => row.type === 'Hike')).toMatchObject({ count: 1, share: 33 })
    expect(rows.find(row => row.type === 'Walk')?.count).toBe(0)
  })

  it('does not divide by zero on an athlete with nothing', () => {
    expect(activityBreakdown([]).every(row => row.count === 0 && row.share === 0)).toBe(true)
  })

  it('reads either spelling of the type', () => {
    expect(activityTypeOf({ activityType: 'Hike' })).toBe('Hike')
    expect(activityTypeOf({ activity_type: 'Hike' })).toBe('Hike')
    expect(activityTypeOf(null)).toBe('')
  })
})

describe('weekBars', () => {
  const history = [
    { week: 'W1', distance: 12, elevation: 0 },
    { week: 'W2', distance: 0, elevation: 0 },
    { week: 'W3', distance: 24, elevation: 0 },
  ]

  it('puts one bar per week inside the box, tallest for the biggest', () => {
    const bars = weekBars(history)

    expect(bars).toHaveLength(3)
    expect(bars[2].height).toBe(WEEK_CHART.height)
    for (const bar of bars) {
      expect(bar.x).toBeGreaterThanOrEqual(0)
      expect(bar.x + bar.width).toBeLessThanOrEqual(WEEK_CHART.width)
      expect(bar.y + bar.height).toBe(WEEK_CHART.height)
    }
  })

  it('gives a week nobody ran no bar at all', () => {
    expect(weekBars(history)[1].height).toBe(0)
  })

  it('has nothing to draw before there is history', () => {
    expect(weekBars([])).toEqual([])
    expect(weekBars(undefined as any)).toEqual([])
  })

  it('shares its geometry with the achievements chart', () => {
    const plain = barGeometry([12, 0, 24], WEEK_CHART)

    expect(weekBars(history).map(({ x, y, width, height }) => ({ x, y, width, height }))).toEqual(plain)
  })
})

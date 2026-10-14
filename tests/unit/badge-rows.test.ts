import { describe, expect, it } from 'bun:test'
import {
  achievementsPath,
  activitiesPath,
  badgeIsEarned,
  badgeProgressText,
  badgeRowsFrom,
  bestMonthText,
  monthBars,
  sortBadges,
  YEAR_CHART,
  yearTotalText,
} from '../../resources/functions/achievements'
import { monthlyProgress } from '../../resources/functions/personal-bests'

/**
 * The showing half of achievements, added to the module the engine already
 * shares when `/achievements` was promoted to a native screen.
 *
 * The chart geometry is the part worth pinning. The web page gives each month
 * a percentage height, which a native screen has no equivalent for, so the
 * bars are computed here and both screens can be wrong in only one place.
 */

const BADGES = {
  achievements: [
    { id: 1, name: 'First Loop', description: 'Close your first loop.', icon: '🔁', progress: 1, total: 1 },
    { id: 2, name: 'Empire Builder', description: 'Hold 10 territories.', icon: '🏰', progress: 3, total: 10 },
    { id: 3, name: 'Century', description: 'Run 100 miles.', icon: '💯', progress: 82, total: 100 },
  ],
}

describe('the endpoints', () => {
  it('asks for one athlete\'s badges', () => {
    expect(achievementsPath(12)).toBe('/api/users/12/achievements')
  })

  it('asks for the rows the records are computed from', () => {
    expect(activitiesPath(12)).toBe('/api/activities?user_id=12&limit=500')
    expect(activitiesPath(12, 50)).toBe('/api/activities?user_id=12&limit=50')
  })
})

describe('badgeRowsFrom', () => {
  it('maps the catalog', () => {
    const rows = badgeRowsFrom(BADGES)

    expect(rows).toHaveLength(3)
    expect(rows[0].name).toBe('First Loop')
    expect(rows[1].progress).toBe(3)
  })

  it('takes a bare array as well as the wrapped payload', () => {
    expect(badgeRowsFrom(BADGES.achievements)).toHaveLength(3)
  })

  /*
   * A badge with no target cannot be earned by progressing, and dividing by it
   * is how a progress bar becomes NaN%.
   */
  it('never carries a total of zero', () => {
    expect(badgeRowsFrom({ achievements: [{ id: 9, total: 0 }] })[0].total).toBe(1)
    expect(badgeRowsFrom({ achievements: [{ id: 9 }] })[0].total).toBe(1)
  })

  it('survives a payload that is not what it should be', () => {
    for (const payload of [null, undefined, {}, 'nope', { achievements: 'nope' }])
      expect(badgeRowsFrom(payload)).toEqual([])
  })
})

describe('how a badge reads', () => {
  const rows = badgeRowsFrom(BADGES)

  it('is earned once the progress reaches the target', () => {
    expect(badgeIsEarned(rows[0])).toBe(true)
    expect(badgeIsEarned(rows[1])).toBe(false)
  })

  /*
   * Achievements never un-earn: progress can fall back (Empire Builder, when
   * territory is lost) and the badge stays earned, so an over-run reads as
   * full rather than as 14/10.
   */
  it('clamps an over-run to the target', () => {
    expect(badgeProgressText({ progress: 14, total: 10 })).toBe('10/10')
    expect(badgeProgressText(rows[1])).toBe('3/10')
  })

  it('puts the earned ones first, then the nearest', () => {
    expect(sortBadges(rows).map(badge => badge.id)).toEqual([1, 3, 2])
  })

  /*
   * Among earned badges the catalog's order is kept. Ranking them by progress
   * would say a 14/10 badge is more earned than a 1/1 one, which is an
   * artefact of the metric rather than an achievement.
   */
  it('does not rank one earned badge above another', () => {
    const earned = badgeRowsFrom({ achievements: [
      { id: 1, name: 'First Loop', progress: 1, total: 1 },
      { id: 2, name: 'Empire Builder', progress: 14, total: 10 },
    ] })

    expect(sortBadges(earned).map(badge => badge.id)).toEqual([1, 2])
  })
})

describe('the year chart', () => {
  const months = monthlyProgress([], 2026).map((month, index) => ({ ...month, miles: [0, 12, 30, 0, 6, 0, 0, 0, 0, 0, 0, 0][index] }))

  it('draws one bar per month, inside the box', () => {
    const bars = monthBars(months)

    expect(bars).toHaveLength(12)
    for (const bar of bars) {
      expect(bar.x).toBeGreaterThanOrEqual(0)
      expect(bar.x + bar.width).toBeLessThanOrEqual(YEAR_CHART.width)
      expect(bar.y).toBeGreaterThanOrEqual(0)
      expect(bar.y + bar.height).toBe(YEAR_CHART.height)
    }
  })

  it('gives the best month the full height', () => {
    const bars = monthBars(months)

    expect(bars[2].height).toBe(YEAR_CHART.height)
    expect(bars[2].y).toBe(0)
  })

  /*
   * A month that was run and a month that was not must not look the same. Six
   * miles against a thirty-mile best is a fifth of the height; the guard
   * matters for the months that round to nothing.
   */
  it('gives a month that was run a sliver, and a month that was not nothing', () => {
    const bars = monthBars(months)

    expect(bars[4].height).toBeGreaterThan(0)
    expect(bars[0].height).toBe(0)
    expect(monthBars(months.map((m, i) => ({ ...m, miles: i === 2 ? 1000 : i === 4 ? 1 : 0 })))[4].height).toBeGreaterThanOrEqual(2)
  })

  it('reads the year and names the biggest month', () => {
    expect(yearTotalText(months)).toBe('48 mi this year')
    expect(bestMonthText(months)).toBe('March was the biggest, at 30 mi')
  })

  it('says nothing about a best month before there is one', () => {
    expect(bestMonthText(monthlyProgress([], 2026))).toBe('')
    expect(yearTotalText(monthlyProgress([], 2026))).toBe('0 mi this year')
  })
})

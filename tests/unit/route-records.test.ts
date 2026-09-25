import type { RecordEffort } from '../../resources/functions/route-records'
import { describe, expect, it } from 'bun:test'
import {
  beatsMoreRestrictiveStyles,
  buildRecordBoards,
  elapsedSeconds,
  evidenceIsSufficient,
  formatElapsed,
  isHeadlineRecord,
  MIN_RECORD_DISTANCE_MI,
  MIN_RECORD_ELEVATION_FT,
  normalizeEvidenceUrl,
  normalizeTrackerUrl,
  outrightRecord,
  rankBucket,
  recordBucketKey,
  recordPace,
  routeIsRankable,
} from '../../resources/functions/route-records'

/**
 * The rules a records board lives or dies by. Every case here is one that
 * would put a wrong name at the top of a route page.
 */

const START = '2026-08-25T06:00:00.000Z'

function effort(overrides: Partial<RecordEffort> & { id: number }): RecordEffort {
  return {
    userId: overrides.id,
    style: 'unsupported',
    category: 'mens',
    direction: 'standard',
    teamSize: 1,
    status: 'verified',
    elapsedSeconds: 36_000,
    startedAt: START,
    finishedAt: null,
    ...overrides,
  }
}

describe('route eligibility', () => {
  it('accepts a route that is long enough', () => {
    expect(routeIsRankable({ distance: MIN_RECORD_DISTANCE_MI, elevation: 0 }).eligible).toBe(true)
  })

  it('accepts a route that is short but steep', () => {
    expect(routeIsRankable({ distance: 1.2, elevation: MIN_RECORD_ELEVATION_FT }).eligible).toBe(true)
  })

  it('rejects a route that is neither, with a reason a form can show', () => {
    const result = routeIsRankable({ distance: 2, elevation: 100 })
    expect(result.eligible).toBe(false)
    expect(result.reason).toContain('5 miles')
  })

  it('treats missing metadata as not rankable rather than assuming the best', () => {
    expect(routeIsRankable({}).eligible).toBe(false)
  })
})

describe('elapsed time', () => {
  it('measures the wall clock, so stops count', () => {
    expect(elapsedSeconds(START, '2026-08-25T16:00:00.000Z')).toBe(36_000)
  })

  it('rejects a finish before the start', () => {
    expect(elapsedSeconds(START, '2026-08-25T05:00:00.000Z')).toBeNull()
  })

  it('rejects a sub-minute time, which is a typo rather than a run', () => {
    expect(elapsedSeconds(START, '2026-08-25T06:00:30.000Z')).toBeNull()
  })

  it('rejects a time longer than any attempted thru-run', () => {
    expect(elapsedSeconds(START, '2027-08-25T06:00:00.000Z')).toBeNull()
  })

  it('rejects unparseable timestamps instead of producing NaN', () => {
    expect(elapsedSeconds('not a date', '2026-08-25T16:00:00.000Z')).toBeNull()
  })
})

describe('formatting', () => {
  it('drops to days once a record runs past a sunrise', () => {
    expect(formatElapsed(2 * 86_400 + 19 * 3600 + 26 * 60)).toBe('2d 19h 26m')
  })

  it('reads as hours and minutes for a long day', () => {
    expect(formatElapsed(9 * 3600 + 4 * 60)).toBe('9h 04m')
  })

  it('keeps seconds for a short effort, where they decide the record', () => {
    expect(formatElapsed(41 * 60 + 12)).toBe('41m 12s')
  })

  it('renders an unfinished attempt as a dash, not as zero', () => {
    expect(formatElapsed(null)).toBe('—')
  })

  it('paces over the whole elapsed clock', () => {
    expect(recordPace(10, 6000)).toBe('10:00/mi')
  })

  it('will not divide by a missing distance', () => {
    expect(recordPace(0, 6000)).toBe('—')
  })
})

describe('bucketing', () => {
  it('separates styles, because a crewed time is a different sport', () => {
    expect(recordBucketKey(effort({ id: 1, style: 'supported' })))
      .not.toBe(recordBucketKey(effort({ id: 2, style: 'unsupported' })))
  })

  it('separates directions on the same route', () => {
    expect(recordBucketKey(effort({ id: 1, direction: 'standard' })))
      .not.toBe(recordBucketKey(effort({ id: 2, direction: 'yo_yo' })))
  })

  it('collapses every team size to one board, so a pair and a trio compete', () => {
    expect(recordBucketKey(effort({ id: 1, teamSize: 2 })))
      .toBe(recordBucketKey(effort({ id: 2, teamSize: 3 })))
  })

  it('keeps solo apart from team', () => {
    expect(recordBucketKey(effort({ id: 1, teamSize: 1 })))
      .not.toBe(recordBucketKey(effort({ id: 2, teamSize: 2 })))
  })
})

describe('ranking', () => {
  it('puts the fastest time first', () => {
    const ranked = rankBucket([
      effort({ id: 1, elapsedSeconds: 40_000 }),
      effort({ id: 2, elapsedSeconds: 30_000 }),
    ])
    expect(ranked.map(entry => entry.id)).toEqual([2, 1])
    expect(ranked[0].rank).toBe(1)
  })

  it('breaks a tie in favour of whoever did it first', () => {
    const ranked = rankBucket([
      effort({ id: 1, elapsedSeconds: 30_000, startedAt: '2026-08-25T06:00:00.000Z' }),
      effort({ id: 2, elapsedSeconds: 30_000, startedAt: '2020-01-01T06:00:00.000Z' }),
    ])
    expect(ranked[0].id).toBe(2)
  })

  it('keeps pending times on the board, since they are claims not fictions', () => {
    const ranked = rankBucket([effort({ id: 1, status: 'pending' })])
    expect(ranked).toHaveLength(1)
  })

  it('drops rejected claims', () => {
    expect(rankBucket([effort({ id: 1, status: 'rejected' })])).toHaveLength(0)
  })

  it('drops attempts that have no time yet', () => {
    expect(rankBucket([effort({ id: 1, status: 'in_progress', elapsedSeconds: null })])).toHaveLength(0)
  })

  it('drops a DNF, which is a fact about the day rather than a ranking', () => {
    expect(rankBucket([effort({ id: 1, status: 'dnf', elapsedSeconds: null })])).toHaveLength(0)
  })
})

describe('boards', () => {
  const efforts = [
    effort({ id: 1, style: 'supported', elapsedSeconds: 30_000 }),
    effort({ id: 2, style: 'unsupported', elapsedSeconds: 40_000 }),
    effort({ id: 3, style: 'unsupported', category: 'womens', elapsedSeconds: 45_000 }),
    effort({ id: 4, status: 'in_progress', elapsedSeconds: null }),
  ]

  it('builds one board per comparable bucket, and none for empty ones', () => {
    const boards = buildRecordBoards(efforts)
    expect(boards).toHaveLength(3)
    expect(boards.every(board => board.entries.length > 0)).toBe(true)
  })

  it('orders the most assisted style first within a category', () => {
    const mens = buildRecordBoards(efforts).filter(board => board.category === 'mens')
    expect(mens.map(board => board.style)).toEqual(['supported', 'unsupported'])
  })

  it('reports the outright fastest across every style and category', () => {
    expect(outrightRecord(efforts)?.id).toBe(1)
  })

  it('has no outright record when nothing has been ranked yet', () => {
    expect(outrightRecord([effort({ id: 9, status: 'in_progress', elapsedSeconds: null })])).toBeNull()
  })
})

describe('headline records', () => {
  it('will not call a supported time the fastest when an unsupported one beats it', () => {
    const supported = effort({ id: 1, style: 'supported', elapsedSeconds: 40_000 })
    const unsupported = effort({ id: 2, style: 'unsupported', elapsedSeconds: 30_000 })
    expect(beatsMoreRestrictiveStyles(supported, [supported, unsupported])).toBe(false)
  })

  it('does call it the fastest when it beats every stricter style', () => {
    const supported = effort({ id: 1, style: 'supported', elapsedSeconds: 20_000 })
    const unsupported = effort({ id: 2, style: 'unsupported', elapsedSeconds: 30_000 })
    expect(beatsMoreRestrictiveStyles(supported, [supported, unsupported])).toBe(true)
  })

  it('always holds for unsupported, which nothing is stricter than', () => {
    const unsupported = effort({ id: 1, style: 'unsupported', elapsedSeconds: 99_000 })
    expect(beatsMoreRestrictiveStyles(unsupported, [unsupported])).toBe(true)
  })

  it('does not compare across categories or directions', () => {
    const supported = effort({ id: 1, style: 'supported', elapsedSeconds: 40_000 })
    const otherCategory = effort({ id: 2, style: 'unsupported', category: 'womens', elapsedSeconds: 10_000 })
    expect(beatsMoreRestrictiveStyles(supported, [supported, otherCategory])).toBe(true)
  })
})

describe('evidence', () => {
  it('needs a trace once there is a time to check', () => {
    expect(evidenceIsSufficient({ status: 'pending' })).toBe(false)
  })

  it('accepts a Wildloop activity as the trace', () => {
    expect(evidenceIsSufficient({ status: 'pending', activityId: 7 })).toBe(true)
  })

  it('exempts an attempt whose evidence does not exist yet', () => {
    expect(evidenceIsSufficient({ status: 'in_progress' })).toBe(true)
  })

  it('accepts a link to a platform that actually holds the recording', () => {
    expect(normalizeEvidenceUrl('https://www.strava.com/activities/123')).toBe('https://www.strava.com/activities/123')
  })

  it('rejects a blog post, which is a trip report rather than a trace', () => {
    expect(normalizeEvidenceUrl('https://example.com/my-big-run')).toBeNull()
  })

  it('rejects http, so a trace cannot be served over a tamperable channel', () => {
    expect(normalizeEvidenceUrl('http://www.strava.com/activities/123')).toBeNull()
  })

  it('rejects a lookalike host that merely contains an allowed name', () => {
    expect(normalizeEvidenceUrl('https://strava.com.evil.test/activities/1')).toBeNull()
  })

  it('accepts a subdomain of an allowed host', () => {
    expect(normalizeEvidenceUrl('https://connect.garmin.com/modern/activity/1')).not.toBeNull()
  })

  it('holds a tracker link to https, but not to a platform allow-list', () => {
    expect(normalizeTrackerUrl('https://share.garmin.com/abc')).toBe('https://share.garmin.com/abc')
    expect(normalizeTrackerUrl('javascript:alert(1)')).toBeNull()
    expect(normalizeTrackerUrl('')).toBeNull()
  })
})

describe('the headline record', () => {
  it('is not awarded to a second-place time, even where no stricter style exists', () => {
    const first = effort({ id: 1, style: 'unsupported', elapsedSeconds: 30_000 })
    const second = effort({ id: 2, style: 'unsupported', elapsedSeconds: 40_000 })
    expect(isHeadlineRecord(second, [first, second])).toBe(false)
    expect(isHeadlineRecord(first, [first, second])).toBe(true)
  })

  it('is not awarded to a crewed time a stricter style has already beaten', () => {
    const supported = effort({ id: 1, style: 'supported', elapsedSeconds: 40_000 })
    const unsupported = effort({ id: 2, style: 'unsupported', elapsedSeconds: 30_000 })
    expect(isHeadlineRecord(supported, [supported, unsupported])).toBe(false)
  })

  it('is awarded when a time leads its board and every stricter one', () => {
    const supported = effort({ id: 1, style: 'supported', elapsedSeconds: 20_000 })
    const unsupported = effort({ id: 2, style: 'unsupported', elapsedSeconds: 30_000 })
    expect(isHeadlineRecord(supported, [supported, unsupported])).toBe(true)
  })
})

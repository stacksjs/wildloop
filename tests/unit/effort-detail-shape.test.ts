import { describe, expect, it } from 'bun:test'
import { pathIdFrom } from '../../resources/functions/route-id'
import {
  courseGeometry,
  courseLineFrom,
  effortActions,
  effortClockText,
  effortCoursePath,
  effortEvidence,
  effortFrom,
  effortPath,
  effortRankText,
  effortReviewPath,
  finishedAtFrom,
  liveElapsedSeconds,
} from '../../resources/functions/route-records'

/**
 * The reading half of one record attempt's page, added when `/effort/:id` was
 * promoted to a native screen.
 *
 * Two things here are the point. The clock takes `now` as a parameter: the web
 * page ticks it every second with `setInterval` and the native runtime has no
 * promised timer, so the shared function computes the same number at an
 * instant the caller names — which is also the only way to test it. And the
 * action gating is read off the server's own `isOwner`/`canReview` rather than
 * decided locally, so a screen cannot offer a button the API refuses.
 */

const STARTED = '2026-10-16T06:00:00.000Z'

function effort(over: Record<string, unknown> = {}) {
  return {
    id: 31,
    userId: 12,
    userName: 'Glenn',
    trailId: 7,
    trailName: 'Steep Ravine Loop',
    trailDistance: 8.2,
    style: 'unsupported',
    category: 'mens',
    direction: 'standard',
    teamSize: 1,
    status: 'verified',
    startedAt: STARTED,
    finishedAt: '2026-10-16T07:12:43.000Z',
    elapsedSeconds: 4363,
    elapsedLabel: '1:12:43',
    paceLabel: '8:52 /mi',
    evidenceUrl: null,
    gpxUrl: null,
    trackerUrl: null,
    tripReport: null,
    reviewNote: null,
    reviewedAt: null,
    rank: 3,
    bucketSize: 12,
    headline: false,
    isOwner: false,
    canReview: false,
    ...over,
  }
}

describe('the effort endpoints', () => {
  it('names one attempt, and its review', () => {
    expect(effortPath(31)).toBe('/api/route-efforts/31')
    expect(effortReviewPath(31)).toBe('/api/route-efforts/31/review')
  })

  /* The course comes from the trail: every attempt on a route shares one. */
  it('reads the course off the trail, not the attempt', () => {
    expect(effortCoursePath(7)).toBe('/api/trails/7')
  })
})

describe('effortFrom', () => {
  it('reads the attempt out of the payload', () => {
    expect(effortFrom({ effort: effort() })?.id).toBe(31)
  })

  it('answers nothing for a payload with no attempt', () => {
    for (const payload of [null, undefined, {}, { effort: null }, { effort: {} }, 'nope'])
      expect(effortFrom(payload)).toBeNull()
  })
})

describe('the clock', () => {
  const start = Date.parse(STARTED)

  /*
   * The API has no elapsed time for an attempt still running — `elapsedLabel`
   * is a dash — which put a dash in the one place a spectator looks first.
   */
  it('counts a running attempt from its start', () => {
    const running = effort({ status: 'in_progress', elapsedLabel: '—', finishedAt: null })

    expect(liveElapsedSeconds(running, start + 90_000)).toBe(90)
    expect(effortClockText(running, start + 90_000)).toBe('1:30')
  })

  /*
   * `formatClock` for the live case and the API's own label for a finished
   * one — the same pair the web page shows, so the two cannot disagree about
   * one attempt. `formatElapsed` would read "1m 30s" here and is the board's
   * format, not this page's.
   */
  it('shows a finished attempt the time it actually took', () => {
    expect(effortClockText(effort(), start + 999_999_999)).toBe('1:12:43')
    expect(liveElapsedSeconds(effort(), start + 999_999_999)).toBeNull()
  })

  /* A clock that ran backwards would read as a negative time. */
  it('never counts below zero', () => {
    const running = effort({ status: 'in_progress' })

    expect(liveElapsedSeconds(running, start - 60_000)).toBe(0)
  })

  /*
   * Falls back to whatever the API said rather than inventing a time. For a
   * running attempt that label is the API's own dash.
   */
  it('falls back to the API label when the start is unreadable', () => {
    const broken = effort({ status: 'in_progress', startedAt: 'not a date', elapsedLabel: '—' })

    expect(liveElapsedSeconds(broken, start)).toBeNull()
    expect(effortClockText(broken, start)).toBe('—')
  })

  it('reads a dash rather than throwing before anything has loaded', () => {
    expect(effortClockText(null, start)).toBe('—')
    expect(liveElapsedSeconds(null, start)).toBeNull()
  })
})

describe('effortRankText', () => {
  it('says where it sits on its board', () => {
    expect(effortRankText(effort())).toBe('3 of 12 on this board')
  })

  it('says nothing when it is not ranked', () => {
    expect(effortRankText(effort({ rank: null }))).toBe('')
    expect(effortRankText(effort({ rank: 0 }))).toBe('')
    expect(effortRankText(null)).toBe('')
  })
})

describe('effortActions', () => {
  /*
   * Read off the server's own flags. A screen that worked out ownership from a
   * locally-held viewer id would offer buttons the API then refuses, and the
   * athlete would learn that from an error.
   */
  it('offers the athlete their own running attempt', () => {
    const mine = effort({ isOwner: true, status: 'in_progress' })

    expect(effortActions(mine)).toEqual({ finish: true, dnf: true, withdraw: true, review: false })
  })

  it('offers nothing of somebody else\'s', () => {
    const theirs = effort({ isOwner: false, status: 'in_progress' })

    expect(effortActions(theirs)).toEqual({ finish: false, dnf: false, withdraw: false, review: false })
  })

  it('stops offering a finish once it has finished', () => {
    const filed = effort({ isOwner: true, status: 'pending' })

    expect(effortActions(filed)).toMatchObject({ finish: false, dnf: false, withdraw: true })
  })

  /* A verified record is the board's, not the athlete's to pull. */
  it('does not offer to withdraw a verified record', () => {
    expect(effortActions(effort({ isOwner: true, status: 'verified' })).withdraw).toBe(false)
  })

  it('offers review only to a reviewer, and only while it is pending', () => {
    expect(effortActions(effort({ canReview: true, status: 'pending' })).review).toBe(true)
    expect(effortActions(effort({ canReview: true, status: 'verified' })).review).toBe(false)
    expect(effortActions(effort({ canReview: false, status: 'pending' })).review).toBe(false)
  })

  it('offers nothing at all before anything has loaded', () => {
    expect(effortActions(null)).toEqual({ finish: false, dnf: false, withdraw: false, review: false })
  })
})

describe('finishedAtFrom', () => {
  it('files a finish at the instant it is given, in ISO', () => {
    const at = Date.parse('2026-10-16T07:12:43.000Z')

    expect(finishedAtFrom(at)).toBe('2026-10-16T07:12:43.000Z')
  })
})

describe('effortEvidence', () => {
  it('lists what the attempt actually carries', () => {
    const rows = effortEvidence(effort({ evidenceUrl: 'https://strava.com/a/1', trackerUrl: 'https://t.example/x' }))

    expect(rows.map(row => row.label)).toEqual(['Activity', 'Live tracker'])
    expect(rows[0].url).toBe('https://strava.com/a/1')
  })

  it('lists nothing for an attempt with no evidence', () => {
    expect(effortEvidence(effort())).toEqual([])
    expect(effortEvidence(null)).toEqual([])
  })
})

describe('courseGeometry', () => {
  it('flattens the course for a MapPolyline', () => {
    expect(courseGeometry([[32.7, -117.1], [32.8, -117.2]])).toEqual([32.7, -117.1, 32.8, -117.2])
  })

  /*
   * Not closed, unlike a territory: a course is a line that goes somewhere,
   * and joining its ends would draw a leg nobody ran.
   */
  it('leaves the line open, because a course is not a loop', () => {
    const flat = courseGeometry([[1, 2], [3, 4], [5, 6]])

    expect(flat).toEqual([1, 2, 3, 4, 5, 6])
    expect(flat.slice(0, 2)).not.toEqual(flat.slice(-2))
  })

  it('has nothing to draw without at least two points', () => {
    expect(courseGeometry(null)).toEqual([])
    expect(courseGeometry([])).toEqual([])
    expect(courseGeometry([[1, 2]])).toEqual([])
  })
})

describe('courseLineFrom', () => {
  /*
   * `/api/trails/{id}` answers stored `geometry`, not a ready `line`. The
   * first version of the native screen read `payload.trail.line`, found
   * nothing and drew no course — silently, because an empty line is also what
   * a route with no stored geometry looks like.
   */
  it('parses the geometry the endpoint actually sends', () => {
    expect(courseLineFrom({ trail: { geometry: [[32.7, -117.1], [32.8, -117.2]] } }))
      .toEqual([[32.7, -117.1], [32.8, -117.2]])
  })

  it('reads the stored JSON string form too', () => {
    expect(courseLineFrom({ trail: { geometry: '[[32.7,-117.1],[32.8,-117.2]]' } })).toHaveLength(2)
  })

  it('finds nothing where there is nothing, rather than throwing', () => {
    for (const payload of [null, undefined, {}, { trail: null }, { trail: {} }, { trail: { geometry: null } }])
      expect(courseLineFrom(payload)).toEqual([])
  })

  /* A `line` key is not what the endpoint sends, and must not be read as one. */
  it('does not read a `line` key that the endpoint never sends', () => {
    expect(courseLineFrom({ trail: { line: [[1, 2], [3, 4]] } })).toEqual([])
  })
})

describe('pathIdFrom', () => {
  it('is the same strictness the territory screen uses', () => {
    expect(pathIdFrom('31')).toBe(31)
    expect(pathIdFrom('31.5.1')).toBeNull()
    expect(pathIdFrom('0')).toBeNull()
  })
})

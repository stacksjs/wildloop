import type { Coordinate } from '../../resources/functions/geo'
import type { BackyardRunnerLaps, BackyardSchedule } from '../../resources/functions/backyard'
import { describe, expect, it } from 'bun:test'
import { backyardProgress, STANDARD_YARD_MILES } from '../../resources/functions/backyard'
import { backyardRunnersFrom, backyardScheduleFrom } from '../../resources/functions/events'
import { pointAlongLine } from '../../resources/functions/geo'

/**
 * Placing the field on the loop without anybody broadcasting a position.
 *
 * The estimate is only defensible because a backyard ultra sends everyone
 * round the same loop at the same gun; these are the cases where a naive
 * elapsed-over-pace would put a head somewhere a spectator can see is wrong.
 */

const START = '2026-08-25T07:00:00.000Z'
const START_MS = Date.parse(START)
const HOUR = 3_600_000
const MINUTE = 60_000

const schedule: BackyardSchedule = {
  startTime: START,
  yardMinutes: 60,
  loopDistance: STANDARD_YARD_MILES,
}

function runner(over: Partial<BackyardRunnerLaps> = {}): BackyardRunnerLaps {
  return { userId: 1, name: 'Ada', status: 'running', yardsCompleted: 0, ...over }
}

describe('placing the field on the loop', () => {
  it('holds everybody on the start line before the gun', () => {
    const [ada] = backyardProgress([runner()], schedule, START_MS - MINUTE)
    expect(ada.state).toBe('corral')
    expect(ada.progress).toBe(0)
  })

  it('puts a runner half way round half a lap into their own pace', () => {
    // A 40-minute lap, 20 minutes into the yard.
    const ada = runner({ yardsCompleted: 2, lapSeconds: [2400, 2400, 2400], lastLapAt: new Date(START_MS + 2 * HOUR - 5 * MINUTE).toISOString() })
    const [at] = backyardProgress([ada], schedule, START_MS + 2 * HOUR + 20 * MINUTE)
    expect(at.progress).toBeCloseTo(0.5, 5)
    expect(at.state).toBe('running')
    expect(at.overdue).toBe(false)
    expect(at.basedOnLaps).toBe(3)
  })

  it('sits a runner who already finished this yard in the corral, not on the course', () => {
    // The clock says yard 3 is running; she finished it four minutes ago and
    // is in a chair. The naive version keeps her moving round the loop.
    const finishedAt = START_MS + 2 * HOUR + 36 * MINUTE
    const ada = runner({ yardsCompleted: 3, lapSeconds: [2160], lastLapAt: new Date(finishedAt).toISOString() })
    const [at] = backyardProgress([ada], schedule, finishedAt + 4 * MINUTE)
    expect(at.state).toBe('corral')
    expect(at.progress).toBe(0)
  })

  it('holds an overdue runner at the line rather than sending them round twice', () => {
    // A 40-minute lap, 50 minutes elapsed: 1.25 laps of progress is not a
    // runner a quarter of the way into a second lap, it is a runner in trouble.
    const ada = runner({ yardsCompleted: 2, lapSeconds: [2400, 2400], lastLapAt: new Date(START_MS + 2 * HOUR - MINUTE).toISOString() })
    const [at] = backyardProgress([ada], schedule, START_MS + 2 * HOUR + 50 * MINUTE)
    expect(at.progress).toBe(1)
    expect(at.overdue).toBe(true)
  })

  it('borrows the field pace for a runner with no laps of their own, and says so', () => {
    const rookie = runner({ userId: 2, name: 'Grace' })
    const known = runner({ userId: 3, lapSeconds: [1800, 1800, 1800] })
    const [grace] = backyardProgress([rookie, known], schedule, START_MS + 15 * MINUTE)
    // 15 minutes against the field's 30-minute lap.
    expect(grace.progress).toBeCloseTo(0.5, 5)
    expect(grace.basedOnLaps).toBe(0)
  })

  it('tracks the fade, weighting recent laps over the whole race', () => {
    // Started at 30 minutes a lap and is now taking 50. The median of the whole
    // race is still 30, so a board that weighed every lap would be placing her
    // at the far side of the loop while she is only half way.
    const ada = runner({ yardsCompleted: 5, lapSeconds: [1800, 1800, 1800, 3000, 3000], lastLapAt: new Date(START_MS + 5 * HOUR - MINUTE).toISOString() })
    const [at] = backyardProgress([ada], schedule, START_MS + 5 * HOUR + 25 * MINUTE)
    expect(at.progress).toBeCloseTo(0.5, 5)
  })

  it('leaves out anybody who missed the corral', () => {
    const out = runner({ userId: 9, status: 'timed_out', yardsCompleted: 1 })
    expect(backyardProgress([out], schedule, START_MS + 3 * HOUR)).toHaveLength(0)
  })
})

describe('walking a line to a fraction', () => {
  // Four unevenly spaced vertices: the first leg is long, the rest are short,
  // which is what a GPS track through a switchback actually looks like.
  const line: Coordinate[] = [
    { lat: 0, lng: 0 },
    { lat: 0, lng: 0.008 },
    { lat: 0, lng: 0.009 },
    { lat: 0, lng: 0.010 },
  ]

  it('measures by distance, not by vertex', () => {
    // Half way is inside the long first leg, not at the second vertex, which
    // is where counting vertices would put it.
    const half = pointAlongLine(line, 0.5)
    expect(half?.lng).toBeCloseTo(0.005, 6)
  })

  it('ends at the ends', () => {
    expect(pointAlongLine(line, 0)?.lng).toBeCloseTo(0, 9)
    expect(pointAlongLine(line, 1)?.lng).toBeCloseTo(0.010, 9)
  })

  it('clamps rather than lapping, so 1.2 is the end and not a second circuit', () => {
    expect(pointAlongLine(line, 1.2)?.lng).toBeCloseTo(0.010, 9)
    expect(pointAlongLine(line, -3)?.lng).toBeCloseTo(0, 9)
  })

  it('answers for the degenerate lines instead of dividing by zero', () => {
    expect(pointAlongLine([], 0.5)).toBeNull()
    expect(pointAlongLine([{ lat: 2, lng: 3 }], 0.5)).toEqual({ lat: 2, lng: 3 })
    const stacked = [{ lat: 1, lng: 1 }, { lat: 1, lng: 1 }]
    expect(pointAlongLine(stacked, 0.5)).toEqual({ lat: 1, lng: 1 })
    expect(pointAlongLine(line, Number.NaN)).toEqual({ lat: 0, lng: 0 })
  })
})

describe('reading the field off the live board', () => {
  // The board as the server sends it: laps newest first, capped across the
  // whole field, with the schedule riding on the event rather than the board.
  const board = {
    status: 'live',
    serverTime: new Date(START_MS + 2 * HOUR + 20 * MINUTE).toISOString(),
    standings: [
      { userId: 1, name: 'Ada', avatar: 'https://example.test/ada.jpg', status: 'running', yardsCompleted: 2, lastLapAt: new Date(START_MS + 2 * HOUR - 5 * MINUTE).toISOString() },
      { userId: 2, name: 'Grace', avatar: null, status: 'running', yardsCompleted: 2, lastLapAt: new Date(START_MS + 2 * HOUR - 8 * MINUTE).toISOString() },
    ],
    recentLaps: [
      { userId: 1, durationSeconds: 3000, finishedAt: new Date(START_MS + 2 * HOUR - 5 * MINUTE).toISOString() },
      { userId: 2, durationSeconds: 2000, finishedAt: new Date(START_MS + 2 * HOUR - 8 * MINUTE).toISOString() },
      { userId: 1, durationSeconds: 1800, finishedAt: new Date(START_MS + HOUR - 5 * MINUTE).toISOString() },
    ],
  }

  it('gives each runner their own laps, oldest first', () => {
    const [ada, grace] = backyardRunnersFrom(board)
    // The feed is newest first, and a pace that reads it in that order would
    // treat Ada's opening 30-minute lap as her most recent.
    expect(ada.lapSeconds).toEqual([1800, 3000])
    expect(grace.lapSeconds).toEqual([2000])
    expect(ada.avatar).toBe('https://example.test/ada.jpg')
  })

  it('leaves a runner with nothing in the capped feed an empty history, not a wrong one', () => {
    const backMarker = { ...board, standings: [...board.standings, { userId: 3, name: 'Edsger', avatar: null, status: 'running', yardsCompleted: 2, lastLapAt: null }] }
    const runners = backyardRunnersFrom(backMarker)
    expect(runners.find(runner => runner.userId === 3)?.lapSeconds).toEqual([])
    // And that runner is then drawn on the field's pace, flagged as a guess.
    const placed = backyardProgress(runners, backyardScheduleFrom({ startTime: START, yardMinutes: 60 }), Date.parse(board.serverTime))
    expect(placed.find(runner => runner.userId === 3)?.basedOnLaps).toBe(0)
  })

  it('takes the schedule off the event, where it lives', () => {
    expect(backyardScheduleFrom({ startTime: START, yardMinutes: 30, loopDistance: 2.5, maxYards: 12 }))
      .toEqual({ startTime: START, yardMinutes: 30, loopDistance: 2.5, maxYards: 12 })
    // A board that arrived without a yard length still has to tick somewhere.
    expect(backyardScheduleFrom({}).yardMinutes).toBe(60)
  })
})

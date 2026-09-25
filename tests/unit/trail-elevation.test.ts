import { describe, expect, it } from 'bun:test'
import {
  elevationLine,
  elevationOutcome,
  elevationRequest,
  MAX_PLAUSIBLE_GAIN_FT,
  MIN_ELEVATION_POINTS,
} from '../../app/Support/trailElevation'

/**
 * Almost no trail in the catalog carries elevation gain, so the page says
 * "Not recorded" and difficulty is graded from length alone (#1003, #1004).
 * The geometry to measure is already stored; these are the decisions the
 * backfill makes around it — which line, and what to do with the answer.
 */

/** A line of `count` points, climbing `stepFt` between each. */
function line(count: number): Array<[number, number]> {
  return Array.from({ length: count }, (_, i) => [34 + i * 0.001, -118 - i * 0.001] as [number, number])
}

describe('elevationLine', () => {
  it('measures the only part of an ordinary trail', () => {
    expect(elevationLine(JSON.stringify(line(12)))).toHaveLength(12)
  })

  // Relation members are stored as separate walkable parts because the
  // straight line between two of them is somebody's back garden. Measuring
  // them glued together would count every one of those jumps as ascent.
  it('measures the main line of a trail stored in parts, never the parts joined', () => {
    const short = [[40, -111], [40.001, -111.001], [40.002, -111.002]]
    const long = line(30)
    const measured = elevationLine(JSON.stringify([short, long]))
    expect(measured).toHaveLength(30)
    expect(measured[0]).toEqual(long[0])
  })

  it('reads an already-parsed line as well as a stored string', () => {
    expect(elevationLine(line(10))).toHaveLength(10)
  })

  it('has nothing to measure without usable geometry', () => {
    for (const geometry of ['', '[]', 'not json', null, undefined, '[[1]]'])
      expect(elevationLine(geometry), String(geometry)).toHaveLength(0)
  })
})

describe('elevationRequest', () => {
  it('asks about a line with enough points to describe a climb', () => {
    const request = elevationRequest(JSON.stringify(line(MIN_ELEVATION_POINTS)))
    expect('line' in request && request.line).toHaveLength(MIN_ELEVATION_POINTS)
  })

  // Two points give the difference between a trail's ends, which is not its
  // ascent — and reporting it as measured is worse than reporting nothing.
  it('does not ask about a line too coarse to answer', () => {
    const request = elevationRequest(JSON.stringify(line(MIN_ELEVATION_POINTS - 1)))
    expect(request).toEqual({ status: 'unmeasurable', reason: 'too-few-points' })
  })

  it('does not ask about a trail with no line at all', () => {
    expect(elevationRequest('')).toEqual({ status: 'unmeasurable', reason: 'no-geometry' })
  })
})

describe('elevationOutcome', () => {
  it('stores whole feet, because the page prints whole feet', () => {
    expect(elevationOutcome(1234.4)).toEqual({ status: 'ok', gainFt: 1234 })
    expect(elevationOutcome(1234.6)).toEqual({ status: 'ok', gainFt: 1235 })
  })

  // The column treats 0 as "not recorded". Writing it would claim a
  // measurement the page then denies, and make the row look done to the next
  // run of the backfill.
  it('never writes a zero gain', () => {
    expect(elevationOutcome(0).status).not.toBe('ok')
    expect(elevationOutcome(0.2)).toEqual({ status: 'ok', gainFt: 0 })
  })

  it.each([null, undefined, Number.NaN, -50])('reports %p as unmeasurable rather than storing it', (value) => {
    expect(elevationOutcome(value as number).status).toBe('unmeasurable')
  })

  // An elevation service that crosses a data void reads the sea floor, and a
  // five-figure gain on one walkable line is that, not a mountain.
  it('parks a gain too large to be a trail instead of publishing it', () => {
    const outcome = elevationOutcome(MAX_PLAUSIBLE_GAIN_FT + 1)
    expect(outcome).toEqual({ status: 'rejected', reason: 'implausible', gainFt: MAX_PLAUSIBLE_GAIN_FT + 1 })
  })

  it('still accepts the biggest gain a real thru-hike could have', () => {
    expect(elevationOutcome(MAX_PLAUSIBLE_GAIN_FT).status).toBe('ok')
  })
})

import type { LatLngPoint, TrackPoint } from '../../resources/functions/segment-matching'
import { describe, expect, it } from 'bun:test'
import { CORRIDOR_METRES, distanceMetres, matchSegment } from '../../resources/functions/segment-matching'

/**
 * Whether an activity ran a segment.
 *
 * A leaderboard is only worth having if the times on it were run. Every case
 * here is one where a looser rule records an effort that did not happen —
 * somebody who took the road, somebody who came down the climb, somebody who
 * turned back — and each of those puts a time on a board that nobody can beat
 * honestly.
 *
 * The opposite failure matters too, and is easier to miss: refusing a real
 * effort because the GPS wandered, or because the athlete ran it twice.
 */

const METRES_PER_DEGREE_LAT = 111_320
const BASE = { lat: 37.8, lng: -122.5 }

/** A point `north` metres north and `east` metres east of the base. */
function at(north: number, east = 0): LatLngPoint {
  const lngScale = 111_320 * Math.cos(BASE.lat * Math.PI / 180)
  return { lat: BASE.lat + north / METRES_PER_DEGREE_LAT, lng: BASE.lng + east / lngScale }
}

/** A straight segment heading north, `points` points over `metres`. */
function straightSegment(metres = 1000, points = 21): LatLngPoint[] {
  return Array.from({ length: points }, (_, i) => at((metres * i) / (points - 1)))
}

/** A track along the given points, one fix every `secondsApart`, starting at t0. */
function trackAlong(points: LatLngPoint[], secondsApart = 10, t0 = 1_790_000_000_000): TrackPoint[] {
  return points.map((point, i) => ({ ...point, time: t0 + i * secondsApart * 1000 }))
}

/** A dense track along a straight line north, one fix per `stepMetres`. */
function runNorth(fromMetres: number, toMetres: number, stepMetres = 25, secondsPerStep = 5, t0 = 1_790_000_000_000): TrackPoint[] {
  const points: TrackPoint[] = []
  const direction = toMetres >= fromMetres ? 1 : -1
  let i = 0
  for (let m = fromMetres; direction > 0 ? m <= toMetres : m >= toMetres; m += direction * stepMetres, i++)
    points.push({ ...at(m), time: t0 + i * secondsPerStep * 1000 })
  return points
}

describe('distanceMetres', () => {
  it('measures a known separation', () => {
    expect(distanceMetres(at(0), at(100))).toBeCloseTo(100, 0)
    expect(distanceMetres(at(0), at(0, 100))).toBeCloseTo(100, 0)
  })
})

describe('matchSegment', () => {
  it('records an effort for a track that runs the whole segment', () => {
    const efforts = matchSegment(runNorth(-200, 1200), straightSegment())

    expect(efforts).toHaveLength(1)
    // 1,000 m at 25 m per 5 s is 200 s, give or take the fix that lands on each end.
    expect(efforts[0].elapsedSeconds).toBeGreaterThan(150)
    expect(efforts[0].elapsedSeconds).toBeLessThan(250)
  })

  /*
   * The case that fills a leaderboard with times nobody ran.
   *
   * Timing from "near the start" to "near the end" accepts an athlete who
   * went a completely different way between them — the road around the hill
   * rather than the trail up it. The whole segment has to be shown.
   */
  it('refuses a track that only visits both ends', () => {
    const segment = straightSegment()
    // Start, then a long detour 300 m to the east, then the finish.
    const detour: TrackPoint[] = trackAlong([
      at(0),
      at(250, 300),
      at(500, 300),
      at(750, 300),
      at(1000),
    ])

    expect(matchSegment(detour, segment)).toEqual([])
  })

  /*
   * A segment has a direction. The descent is not the climb, and a board that
   * mixes them is not a board.
   */
  it('refuses the same ground run the other way', () => {
    expect(matchSegment(runNorth(1200, -200), straightSegment())).toEqual([])
  })

  it('refuses a track that turns back before the finish', () => {
    // Three quarters of the way up, then home.
    const out = runNorth(0, 750)
    const back = runNorth(750, 0, 25, 5, 1_790_000_000_000 + out.length * 5000)
    expect(matchSegment([...out, ...back], straightSegment())).toEqual([])
  })

  it('refuses a track that joins halfway up', () => {
    expect(matchSegment(runNorth(500, 1200), straightSegment())).toEqual([])
  })

  /*
   * Hill repeats. Six runs of the same climb in one activity is six efforts,
   * not one, and not one long one spanning the rests between them.
   */
  it('records every lap separately', () => {
    const segment = straightSegment()
    let clock = 1_790_000_000_000
    const track: TrackPoint[] = []
    for (let lap = 0; lap < 3; lap++) {
      const up = runNorth(0, 1000, 25, 5, clock)
      clock = up[up.length - 1].time! + 5000
      const down = runNorth(1000, 0, 25, 4, clock)
      clock = down[down.length - 1].time! + 5000
      track.push(...up, ...down)
    }

    const efforts = matchSegment(track, segment)
    expect(efforts).toHaveLength(3)
    // Each effort is its own climb, and they do not overlap.
    for (let i = 1; i < efforts.length; i++)
      expect(efforts[i].startIndex).toBeGreaterThan(efforts[i - 1].endIndex)
  })

  it('tolerates GPS wander inside the corridor', () => {
    const segment = straightSegment()
    // Running the line, drifting up to about fifteen metres to the side.
    const wobbly = runNorth(-100, 1100).map((point, i) => ({
      ...at(-100 + i * 25, Math.sin(i / 3) * 15),
      time: point.time,
    }))

    expect(matchSegment(wobbly, segment)).toHaveLength(1)
  })

  it('refuses a parallel path outside the corridor', () => {
    const segment = straightSegment()
    // The road eighty metres over, running the same way.
    const parallel = runNorth(-200, 1200).map((point, i) => ({ ...at(-200 + i * 25, 80), time: point.time }))

    expect(matchSegment(parallel, segment)).toEqual([])
  })

  it('leaves an activity nowhere near the segment alone', () => {
    // A different mountain range. This is also the path almost every
    // (activity, segment) pair takes, so it has to be the cheap one.
    const elsewhere = trackAlong(Array.from({ length: 50 }, (_, i) => ({ lat: 45 + i * 0.001, lng: -110 })))
    expect(matchSegment(elsewhere, straightSegment())).toEqual([])
  })

  describe('what it refuses to time', () => {
    it('will not time a track with no clock', () => {
      const untimed = runNorth(-200, 1200).map(point => ({ ...point, time: null }))
      expect(matchSegment(untimed, straightSegment())).toEqual([])
    })

    it('will not record an effort that took no time', () => {
      // Every fix stamped identically: a broken track, not a fast athlete.
      const frozen = runNorth(-200, 1200).map(point => ({ ...point, time: 1_790_000_000_000 }))
      expect(matchSegment(frozen, straightSegment())).toEqual([])
    })

    it('will not match a segment too short to have a shape', () => {
      // Two points is a line between two places, and matching it accepts
      // anything that passed both ends.
      const twoPoints = [at(0), at(1000)]
      expect(matchSegment(runNorth(-200, 1200), twoPoints)).toEqual([])
    })

    it('will not match an empty or one-point track', () => {
      expect(matchSegment([], straightSegment())).toEqual([])
      expect(matchSegment([{ ...at(0), time: 1 }], straightSegment())).toEqual([])
    })
  })

  describe('the effort it reports', () => {
    it('times from reaching the start to reaching the finish', () => {
      const track = runNorth(-200, 1200, 25, 5)
      const [effort] = matchSegment(track, straightSegment())

      expect(effort.startedAt).toBe(track[effort.startIndex].time)
      expect(effort.elapsedSeconds)
        .toBe(Math.round((track[effort.endIndex].time! - track[effort.startIndex].time!) / 1000))
    })

    it('starts at the first fix inside the corridor, not the nearest one', () => {
      // An effort is timed from when somebody reached the start, not from
      // whichever later fix sat closest to the drawn line.
      const track = runNorth(-200, 1200)
      const [effort] = matchSegment(track, straightSegment())
      const startPoint = track[effort.startIndex]

      expect(distanceMetres(startPoint, at(0))).toBeLessThanOrEqual(CORRIDOR_METRES)
      if (effort.startIndex > 0)
        expect(distanceMetres(track[effort.startIndex - 1], at(0))).toBeGreaterThan(CORRIDOR_METRES)
    })
  })
})

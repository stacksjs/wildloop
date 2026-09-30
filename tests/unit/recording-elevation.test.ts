import { describe, expect, it } from 'bun:test'
import {
  ALTITUDE_FLOOR_FT,
  emptyElevation,
  stepElevation,
  totalGainFt,
} from '../../resources/functions/recording-elevation'

/**
 * How much an activity climbed.
 *
 * GPS altitude is the noisiest number a phone reports — vertical error runs one
 * and a half to three times the horizontal — so counting every rise above a
 * three-foot floor counted the receiver sitting still. The consequence was not
 * only a wrong number on the page: the store action refuses an activity whose
 * elevation falls outside 0 to 100,000 feet, and a long enough day cleared
 * that ceiling, so the run was rejected at save.
 */

/** Feed a series of altitudes through the accumulator. */
function climb(altitudes: Array<number | null>): number {
  let state = emptyElevation()
  for (const ft of altitudes) state = stepElevation(state, ft)
  return state.gainFt
}

/** `count` readings wandering around `base` by ±`spread` feet, the way a receiver does. */
function wander(base: number, count: number, spread: number): number[] {
  return Array.from({ length: count }, (_, i) => base + Math.sin(i / 7) * spread + Math.cos(i / 3) * (spread / 2))
}

describe('stepElevation', () => {
  it('climbs nothing while the receiver wanders on a table', () => {
    // Twenty minutes at a fix a second, drifting fifteen feet either way —
    // well inside ordinary vertical noise, and not a hill.
    expect(climb(wander(500, 1200, 15))).toBeLessThan(ALTITUDE_FLOOR_FT * 2)
  })

  it('counts a real climb', () => {
    // Six hundred feet up over ten minutes.
    const ascent = Array.from({ length: 600 }, (_, i) => 100 + i)
    expect(climb(ascent)).toBeGreaterThan(550)
    expect(climb(ascent)).toBeLessThan(620)
  })

  /*
   * The rule that keeps a long descent from paying out.
   *
   * Without moving the reference down as the ground falls, every step back up
   * would be measured from the summit and count again.
   */
  it('does not bank gain for going downhill', () => {
    const descent = Array.from({ length: 600 }, (_, i) => 700 - i)
    expect(climb(descent)).toBe(0)
  })

  it('counts each side of a valley once', () => {
    const down = Array.from({ length: 400 }, (_, i) => 500 - i)
    const up = Array.from({ length: 400 }, (_, i) => 100 + i)
    const gain = climb([...down, ...up])
    // One climb of about four hundred feet, not two.
    expect(gain).toBeGreaterThan(330)
    expect(gain).toBeLessThan(430)
  })

  /*
   * A browser with no altitude reports null, and that is not sea level. Reading
   * it as one would record a descent of the whole altitude and then re-climb
   * it — the shape of a phantom mountain on every activity.
   */
  it('ignores a reading with no altitude rather than treating it as zero', () => {
    const withGaps = [1000, null, 1000, null, 1000, null, 1000]
    expect(climb(withGaps)).toBe(0)

    // The shape that makes it expensive: a long gap at altitude, then the
    // signal returning. Read as sea level, the smoothed value dives to zero
    // and the recovery banks the whole mountain on the way back up.
    const longGap = [
      ...Array.from({ length: 200 }, () => 4000),
      ...Array.from({ length: 400 }, () => null),
      ...Array.from({ length: 200 }, () => 4000),
    ]
    expect(climb(longGap)).toBe(0)

    // And a gap in the middle of a climb does not reset it.
    const interrupted = [...Array.from({ length: 300 }, (_, i) => 100 + i), null, null, ...Array.from({ length: 300 }, (_, i) => 400 + i)]
    expect(climb(interrupted)).toBeGreaterThan(500)
  })

  it('ignores a reading that is not a number', () => {
    expect(climb([100, Number.NaN as any, 100])).toBe(0)
  })

  it('does not mutate the state it was given', () => {
    const state = stepElevation(emptyElevation(), 100)
    const before = { ...state }
    stepElevation(state, 5000)
    expect(state).toEqual(before)
  })
})

describe('totalGainFt', () => {
  it('replays a stored track to the number the live run produced', () => {
    const samples = Array.from({ length: 500 }, (_, i) => ({ eleFt: 200 + i * 0.8 }))
    let live = emptyElevation()
    for (const s of samples) live = stepElevation(live, s.eleFt)

    expect(totalGainFt(samples)).toBeCloseTo(live.gainFt, 9)
  })

  it('is zero for a track with no altitude at all', () => {
    expect(totalGainFt([])).toBe(0)
    expect(totalGainFt([{ eleFt: null }, { eleFt: null }])).toBe(0)
  })
})

describe('a ten-hour day', () => {
  /*
   * The failure that loses the activity.
   *
   * Elevation outside 0 to 100,000 feet fails validation in the store action,
   * so an inflated total does not merely read wrong — it refuses the save.
   * Simulated against the old rule, ten hours of ordinary vertical noise
   * reported between 58,000 and 298,000 feet.
   */
  it('stays nowhere near the ceiling that would refuse the save', () => {
    // Ten hours at one fix a second: a steady 8,000 ft of climb, under noise.
    const readings: number[] = []
    for (let t = 0; t < 10 * 3600; t++) {
      const real = (8000 * t) / (10 * 3600)
      const noise = Math.sin(t / 31) * 20 + Math.cos(t / 17) * 14
      readings.push(real + noise)
    }

    const gain = climb(readings)
    expect(gain).toBeLessThan(100_000)
    // And close enough to the truth to be worth printing.
    expect(gain).toBeGreaterThan(7_000)
    expect(gain).toBeLessThan(20_000)
  })
})

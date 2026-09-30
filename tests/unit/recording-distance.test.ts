import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_FLOOR_M,
  emptyAnchor,
  haversineMiles,
  MAX_TRUSTED_ACCURACY_M,
  step,
  stepFloorMetres,
  totalMiles,
} from '../../resources/functions/recording-distance'

/**
 * How far a recording has actually travelled.
 *
 * The recorder used to add the gap between every consecutive GPS fix, which
 * charges the athlete for the receiver's own wander. Both failure directions
 * are covered here, because they are not equally bad: reporting somebody's
 * fifty-mile race as fifty-four is annoying, and reporting it as thirty-five
 * takes the race away from them.
 */

const SAN_DIEGO: [number, number] = [32.7157, -117.1611]
const METRES_PER_DEGREE_LAT = 111_320

/** A point `metres` north of another. */
function north(from: [number, number], metres: number): [number, number] {
  return [from[0] + metres / METRES_PER_DEGREE_LAT, from[1]]
}

describe('stepFloorMetres', () => {
  it('trusts a good fix no further than the default', () => {
    // A receiver claiming one metre on a phone is being optimistic, and
    // believing it would put the noise floor back under the noise.
    expect(stepFloorMetres(1)).toBe(DEFAULT_FLOOR_M)
    expect(stepFloorMetres(0)).toBe(DEFAULT_FLOOR_M)
  })

  it('widens the floor to match a vaguer fix', () => {
    expect(stepFloorMetres(25)).toBe(25)
    expect(stepFloorMetres(60)).toBe(60)
  })

  it('has an answer when the device will not say', () => {
    // Desktop browsers and some WebViews report null.
    for (const value of [null, undefined, Number.NaN, -1])
      expect(stepFloorMetres(value as any)).toBe(DEFAULT_FLOOR_M)
  })
})

describe('step', () => {
  it('starts the effort at the first believable fix, with no distance', () => {
    const result = step(emptyAnchor(), SAN_DIEGO, 5)
    expect(result.miles).toBe(0)
    expect(result.point).toEqual(SAN_DIEGO)
    expect(result.moved).toBe(true)
  })

  /*
   * The bug this file exists for.
   *
   * Standing still, a one-hertz receiver with a five-metre radius produced
   * somewhere between one and nine phantom miles an hour, because every fix
   * was counted as travel from the last one.
   */
  it('adds nothing while the receiver wanders inside its own noise', () => {
    let anchor = step(emptyAnchor(), SAN_DIEGO, 5)
    for (let i = 0; i < 200; i++) {
      // Jitter of a few metres, never a real step.
      const wobble = north(SAN_DIEGO, (i % 7) - 3)
      anchor = step(anchor, wobble, 5)
    }
    expect(anchor.miles).toBe(0)
  })

  /*
   * The trap in the obvious fix.
   *
   * If a fix inside the noise were adopted as the new anchor, the reference
   * would drift along with the receiver and the floor would never be crossed:
   * a slow climb would record as zero. The anchor has to stay put.
   */
  it('does not let the anchor drift with the noise', () => {
    let anchor = step(emptyAnchor(), SAN_DIEGO, 5)
    const start = anchor.point!
    for (let i = 1; i <= 8; i++)
      anchor = step(anchor, north(SAN_DIEGO, i), 5) // 1m at a time, under the floor
    expect(anchor.point).toEqual(start)
    expect(anchor.miles).toBe(0)
  })

  /*
   * And the consequence of keeping it still: a walker still travels. Eight
   * one-metre steps bank nothing, the ninth crosses the floor and banks the
   * whole nine metres at once. Quantised, not lost.
   */
  it('banks the whole distance once the athlete has demonstrably moved', () => {
    let anchor = step(emptyAnchor(), SAN_DIEGO, 5)
    for (let i = 1; i <= DEFAULT_FLOOR_M + 1; i++)
      anchor = step(anchor, north(SAN_DIEGO, i), 5)

    const expected = haversineMiles(SAN_DIEGO, north(SAN_DIEGO, DEFAULT_FLOOR_M + 1))
    expect(anchor.miles).toBeCloseTo(expected, 5)
    expect(anchor.point).toEqual(north(SAN_DIEGO, DEFAULT_FLOOR_M + 1))
  })

  it('measures a real stride in full', () => {
    const first = step(emptyAnchor(), SAN_DIEGO, 5)
    const second = step(first, north(SAN_DIEGO, 50), 5)
    expect(second.added).toBeCloseTo(haversineMiles(SAN_DIEGO, north(SAN_DIEGO, 50)), 6)
    expect(second.moved).toBe(true)
  })

  /*
   * A fix whose own radius is larger than a city block. Neither travel nor a
   * new reference — adopting it would move the anchor to a place the device
   * itself does not believe, and the next real fix would then read as a jump.
   */
  it('ignores a fix the device has no confidence in', () => {
    const anchor = step(emptyAnchor(), SAN_DIEGO, 5)
    const wild = step(anchor, north(SAN_DIEGO, 5000), MAX_TRUSTED_ACCURACY_M + 1)

    expect(wild.miles).toBe(0)
    expect(wild.point).toEqual(anchor.point)
    expect(wild.moved).toBe(false)
  })

  it('still records travel on a vague but usable fix', () => {
    // The floor widens with the radius instead of rejecting outright, so a
    // cloudy day costs precision rather than the whole run.
    const anchor = step(emptyAnchor(), SAN_DIEGO, 60)
    const near = step(anchor, north(SAN_DIEGO, 30), 60) // under a 60m floor
    expect(near.miles).toBe(0)

    const far = step(anchor, north(SAN_DIEGO, 120), 60)
    expect(far.miles).toBeGreaterThan(0)
  })

  it('does not mutate the anchor it was given', () => {
    const anchor = step(emptyAnchor(), SAN_DIEGO, 5)
    const before = { ...anchor }
    step(anchor, north(SAN_DIEGO, 500), 5)
    expect(anchor).toEqual(before)
  })
})

describe('totalMiles', () => {
  it('replays a stored track to the same number the live run produced', () => {
    const samples = Array.from({ length: 40 }, (_, i) => ({
      lat: north(SAN_DIEGO, i * 25)[0],
      lng: SAN_DIEGO[1],
      accuracy: 5,
    }))

    let anchor = emptyAnchor()
    for (const s of samples) anchor = step(anchor, [s.lat, s.lng], s.accuracy)

    expect(totalMiles(samples)).toBeCloseTo(anchor.miles, 9)
  })

  it('skips a sample with no usable position rather than counting a jump to nowhere', () => {
    const miles = totalMiles([
      { lat: SAN_DIEGO[0], lng: SAN_DIEGO[1], accuracy: 5 },
      { lat: Number.NaN, lng: Number.NaN, accuracy: 5 },
      { lat: north(SAN_DIEGO, 100)[0], lng: SAN_DIEGO[1], accuracy: 5 },
    ])
    expect(miles).toBeCloseTo(haversineMiles(SAN_DIEGO, north(SAN_DIEGO, 100)), 6)
  })

  it('is zero for a track that never went anywhere', () => {
    expect(totalMiles([])).toBe(0)
    expect(totalMiles([{ lat: SAN_DIEGO[0], lng: SAN_DIEGO[1], accuracy: 5 }])).toBe(0)
  })
})

describe('a fifty-mile day', () => {
  /*
   * The shape of Chris's run: long, slow, and punctuated by stops. The old
   * rule charged for every stop; this one has to not.
   */
  it('does not charge for standing at an aid station', () => {
    let anchor = step(emptyAnchor(), SAN_DIEGO, 5)

    // Run a mile.
    for (let m = 20; m <= 1609; m += 20) anchor = step(anchor, north(SAN_DIEGO, m), 5)
    const afterRunning = anchor.miles
    expect(afterRunning).toBeGreaterThan(0.9)

    // Stand still for ten minutes at one fix a second, wandering in the noise.
    //
    // Settling costs at most one step: the athlete really did cover the last
    // few metres to where they stopped, and the anchor catches up once. What
    // must not happen is that the ten minutes keep paying out.
    const station = north(SAN_DIEGO, 1609)
    for (let t = 0; t < 60; t++)
      anchor = step(anchor, north(station, (t % 9) - 4), 5)
    const settled = anchor.miles

    for (let t = 0; t < 540; t++)
      anchor = step(anchor, north(station, (t % 9) - 4), 5)

    // Nine further minutes of standing: not one further foot.
    expect(anchor.miles).toBe(settled)
    // And the whole stop cost under a hundredth of a mile, against the one to
    // nine miles an hour the old rule charged for standing there.
    expect(settled - afterRunning).toBeLessThan(0.01)
  })
})

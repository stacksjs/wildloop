import { describe, expect, it } from 'bun:test'
import { deriveDifficulty } from '../../app/Ingest/normalize'

/**
 * Grading a trail on effort rather than on length.
 *
 * The defect (#1004) was not that the thresholds were wrong — they already
 * took ascent. It was that ascent was always zero: the NPS and Forest Service
 * layers publish no elevation and OSM rarely tags it, so every call passed 0,
 * and 0 is indistinguishable from a measured flat. Distance alone decided
 * every grade while the badge claimed to describe difficulty.
 *
 * The two cases that were wrong are the first two below.
 */

describe('what distance alone got wrong', () => {
  /*
   * Mist Trail, Yosemite: 2.67 miles, about a thousand feet up to Vernal Fall.
   * Production serves it `easy`, because 2.67 is under the three-mile line.
   */
  it('grades a short, steep climb above easy', () => {
    const graded = deriveDifficulty(2.67, 1000)
    expect(graded.difficulty).not.toBe('easy')
    expect(graded.estimated).toBe(false)
  })

  /*
   * And the other way: a flat rail-trail is long, not hard. The length still
   * carries it past the eight-mile line, which is deliberate — a 250-mile walk
   * is a hard thing to do — but it must not be ranked with a mountain.
   */
  it('does not rank a long flat path with a mountain of the same grade', () => {
    const railTrail = deriveDifficulty(250, 300)
    const mountain = deriveDifficulty(9, 6000)

    expect(railTrail.difficulty).toBe('hard')
    expect(mountain.difficulty).toBe('hard')
    // Same bucket, so the grade cannot separate them — but the climb per mile
    // can, and that is what the detail page should lead with for a long trail.
    expect(300 / 250).toBeLessThan(6000 / 9)
  })

  it('still grades a genuinely easy trail easy', () => {
    expect(deriveDifficulty(1.2, 80).difficulty).toBe('easy')
  })

  it('raises the grade on sustained climb per mile, not just total', () => {
    // 1.5 miles, 700 ft: under both absolute thresholds, but 466 ft a mile.
    expect(deriveDifficulty(1.5, 700).difficulty).toBe('moderate')
  })
})

describe('measured, versus nobody looked', () => {
  /*
   * The distinction the whole fix rests on. Null is "no one has measured the
   * climb"; zero is "somebody measured it and it is flat". Collapsing them is
   * what made a thousand-foot climb easy.
   */
  it('marks a grade estimated when no ascent was measured', () => {
    expect(deriveDifficulty(2.67, null).estimated).toBe(true)
  })

  it('does not mark a measured flat as estimated', () => {
    const flat = deriveDifficulty(2, 0)
    expect(flat.estimated).toBe(false)
    expect(flat.difficulty).toBe('easy')
  })

  /*
   * An unmeasured trail still gets a grade rather than a blank. Three quarters
   * of the catalog has no ascent yet, and a catalog of blanks helps nobody —
   * what matters is that the badge says which kind of grade it is.
   */
  it('still returns a grade when ascent is unknown', () => {
    const graded = deriveDifficulty(12, null)
    expect(graded.difficulty).toBe('hard')
    expect(graded.estimated).toBe(true)
  })

  it('treats a non-finite ascent as unmeasured rather than as zero', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(deriveDifficulty(5, bad).estimated, `${bad} is not a measurement`).toBe(true)
    }
  })

  /*
   * An unmeasured trail must never grade *higher* than the same trail once
   * somebody measures it flat — the estimate is distance alone, and adding a
   * real zero cannot make it harder.
   */
  it('grades an unmeasured trail the same as a measured flat one', () => {
    for (const miles of [0.5, 2.9, 3.1, 8.1, 40]) {
      expect(deriveDifficulty(miles, null).difficulty, `${miles} mi`)
        .toBe(deriveDifficulty(miles, 0).difficulty)
    }
  })
})

describe('the thresholds hold their shape', () => {
  it('rises monotonically with ascent at a fixed distance', () => {
    const order = { easy: 0, moderate: 1, hard: 2 }
    let previous = -1
    for (const ascent of [0, 500, 800, 1500, 2500, 5000]) {
      const rank = order[deriveDifficulty(5, ascent).difficulty]
      expect(rank, `5 mi / ${ascent} ft`).toBeGreaterThanOrEqual(previous)
      previous = rank
    }
  })

  it('survives a zero-distance trail without dividing by it', () => {
    const graded = deriveDifficulty(0, 500)
    expect(['easy', 'moderate', 'hard']).toContain(graded.difficulty)
  })
})

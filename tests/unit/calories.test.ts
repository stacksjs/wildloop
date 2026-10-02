import { describe, expect, it } from 'bun:test'
import { estimateCalories, REFERENCE_WEIGHT_KG } from '../../resources/functions/calories'

/**
 * The calorie estimate.
 *
 * Two things are worth pinning. First that it is in the right neighbourhood —
 * an estimate nobody sanity-checked against reality is just a different
 * arbitrary constant. Second, and more important, that it actually responds to
 * the things the old formula ignored: an hour's walk and an hour's run are not
 * the same, and neither are the same distance flat and up a mountain. That
 * responsiveness is the entire reason for replacing `distance * 95` (#1011).
 */

const run = (over: Partial<Parameters<typeof estimateCalories>[0]> = {}) => estimateCalories({
  activityType: 'Trail Run',
  distanceMiles: 6,
  movingTime: '1:00:00',
  elevationGainFeet: 0,
  ...over,
})

describe('estimateCalories', () => {
  /*
   * An hour of running at 10:00/mile for a 70 kg adult is about 700 kcal by
   * every published table. This is the one anchor the whole model hangs off,
   * so it is checked tightly; everything else is checked by its relationships.
   */
  it('puts an hour of six-mile-an-hour running near 700 kcal', () => {
    const kcal = run()!
    expect(kcal).toBeGreaterThan(600)
    expect(kcal).toBeLessThan(800)
  })

  it('puts an hour of walking far below an hour of running', () => {
    const walking = estimateCalories({ activityType: 'Walk', distanceMiles: 3, movingTime: '1:00:00' })!
    const running = run()!
    expect(walking).toBeLessThan(running / 2)
    // Still a real number: three miles on foot is not nothing.
    expect(walking).toBeGreaterThan(150)
  })

  /*
   * Ranked by intensity — kilocalories per hour, each type at its own typical
   * pace. This is the comparison that holds.
   *
   * Two orderings it deliberately does NOT claim. Not that a run always beats
   * a hike at the same speed: four miles an hour over rough ground on foot is
   * hard work, while a four-mile-an-hour "run" is a shuffle, and the model is
   * right to rank them by effort rather than by the word on the activity. And
   * not that a run beats a hike in total: two hours of hiking burns more than
   * forty minutes of running, which is both what this returns and what anyone
   * who has done the two would tell you.
   */
  it('ranks the four types by intensity at their typical paces', () => {
    const perHour = (activityType: string, distanceMiles: number) =>
      estimateCalories({ activityType, distanceMiles, movingTime: '1:00:00' })!

    const running = perHour('Trail Run', 6)
    const cycling = perHour('Bike', 14)
    const hiking = perHour('Hike', 2.5)
    const walking = perHour('Walk', 3)

    expect(running).toBeGreaterThan(cycling)
    expect(cycling).toBeGreaterThan(hiking)
    expect(hiking).toBeGreaterThan(walking)
  })

  describe('what the flat multiplier could not see', () => {
    /*
     * Running is the one type where duration cancels out, so the same distance
     * at any pace gets the same number. Pinned deliberately, because it looks
     * like a bug and is not: running costs a roughly fixed amount per mile.
     * Anyone who "fixes" this by bending the exponent should have to delete
     * this test and argue with the Compendium first.
     */
    it('gives a run the same figure whatever the pace, because distance is the cost', () => {
      const quick = estimateCalories({ activityType: 'Trail Run', distanceMiles: 6, movingTime: '0:45:00' })!
      const slow = estimateCalories({ activityType: 'Trail Run', distanceMiles: 6, movingTime: '1:30:00' })!
      expect(quick).toBe(slow)
    })

    /*
     * Walking is where pace genuinely moves the number, because a brisk walk
     * is a different activity from an amble and the exponent is below one.
     */
    it('charges a brisk walk more per mile than an amble', () => {
      const brisk = estimateCalories({ activityType: 'Walk', distanceMiles: 3, movingTime: '0:45:00' })!
      const amble = estimateCalories({ activityType: 'Walk', distanceMiles: 3, movingTime: '1:30:00' })!
      expect(amble).toBeGreaterThan(brisk)
    })

    it('charges for climbing', () => {
      const flat = run({ elevationGainFeet: 0 })!
      const climbed = run({ elevationGainFeet: 3000 })!
      expect(climbed).toBeGreaterThan(flat)
      /*
       * 3000 ft is ~914 m. Raising 70 kg that far at ~22% muscle efficiency is
       * ~800 kcal, so the climb should be a substantial share of the total —
       * not a rounding error, which is what folding it into the MET would do.
       */
      expect(climbed - flat).toBeGreaterThan(500)
      expect(climbed - flat).toBeLessThan(1000)
    })

    it('does not give a bike the same figure as a run over the same distance', () => {
      const shared = { distanceMiles: 14, movingTime: '1:00:00' }
      const cycling = estimateCalories({ ...shared, activityType: 'Bike' })!
      const running = estimateCalories({ ...shared, activityType: 'Trail Run' })!
      expect(cycling).toBeLessThan(running)
    })
  })

  describe('when it will not guess', () => {
    /*
     * Null, never zero. Zero is a claim that the activity burned nothing, and
     * the importer used to write exactly that for every file it read — a
     * confident nought on a real marathon.
     */
    it('returns null without a moving time', () => {
      expect(estimateCalories({ activityType: 'Trail Run', distanceMiles: 6, movingTime: null })).toBeNull()
      expect(estimateCalories({ activityType: 'Trail Run', distanceMiles: 6, movingTime: '' })).toBeNull()
      expect(estimateCalories({ activityType: 'Trail Run', distanceMiles: 6, movingTime: 0 })).toBeNull()
    })

    it('still estimates from time and type when distance is missing', () => {
      // A manual "two hours of hiking" with no GPS is worth a number.
      const kcal = estimateCalories({ activityType: 'Hike', distanceMiles: null, movingTime: '2:00:00' })
      expect(kcal).not.toBeNull()
      expect(kcal!).toBeGreaterThan(500)
    })
  })

  describe('shapes it has to accept', () => {
    it('takes seconds as readily as a duration string', () => {
      const asString = estimateCalories({ activityType: 'Hike', distanceMiles: 4, movingTime: '1:30:00' })
      const asSeconds = estimateCalories({ activityType: 'Hike', distanceMiles: 4, movingTime: 5400 })
      expect(asSeconds).toBe(asString)
    })

    it('survives nonsense without throwing or returning NaN', () => {
      for (const bad of [
        { activityType: '', distanceMiles: Number.NaN, movingTime: '1:00:00' },
        { activityType: 'Trail Run', distanceMiles: -5, movingTime: '1:00:00' },
        { activityType: 'Trail Run', distanceMiles: 6, movingTime: '1:00:00', elevationGainFeet: -200 },
        { activityType: 'Kayak', distanceMiles: 3, movingTime: '0:30:00' },
      ]) {
        const kcal = estimateCalories(bad)
        expect(kcal === null || Number.isFinite(kcal)).toBe(true)
      }
    })

    /*
     * A 100-mile-an-hour "run" is a car, or a broken distance. The speed ratio
     * is clamped so a bad input produces a wrong number rather than a comic
     * one — the integrity pass is what rejects the activity itself.
     */
    it('clamps an impossible pace instead of multiplying by it', () => {
      const absurd = estimateCalories({ activityType: 'Trail Run', distanceMiles: 100, movingTime: '1:00:00' })!
      expect(absurd).toBeLessThan(5000)
    })
  })

  it('names the body it is estimating for, since it is not the athlete', () => {
    // The figure is per a reference adult, not per the person who ran it, and
    // the number is the only honest way to say so in code.
    expect(REFERENCE_WEIGHT_KG).toBe(70)
  })
})

describe('against the real activities this replaces', () => {
  /*
   * The four production rows quoted in #1011, where the old formula was exact:
   * 41.7 mi showed 3,962 and 41.7 x 95 is 3,962. Checked here as a spread
   * rather than per-row — the point is that a ten-hour ultra and a one-hour
   * run no longer sit on the same straight line through the origin.
   */
  it('no longer returns a fixed multiple of distance', () => {
    const ultra = estimateCalories({ activityType: 'Trail Run', distanceMiles: 41.7, movingTime: '10:00:00', elevationGainFeet: 3200 })!
    const tempo = estimateCalories({ activityType: 'Trail Run', distanceMiles: 7.8, movingTime: '1:05:00', elevationGainFeet: 900 })!

    const ultraPerMile = ultra / 41.7
    const tempoPerMile = tempo / 7.8
    expect(Math.abs(ultraPerMile - tempoPerMile)).toBeGreaterThan(10)
  })
})

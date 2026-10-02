import { describe, expect, it } from 'bun:test'
import { normalizeTrailsPayload } from '../../resources/assets/scripts/trail-data'
import {
  difficultyIsEstimated,
  difficultyLabel,
  difficultyTitle,
} from '../../resources/functions/trail-difficulty'

/**
 * How the badge says which kind of grade it is carrying.
 *
 * Three quarters of the catalog has no measured ascent, so its grade is
 * distance alone (#1004). Rather than blank those badges — a catalog with no
 * difficulty on it helps nobody — they are marked, and the mark is derived
 * from the stored elevation so it clears itself the moment the elevation
 * backfill reaches a trail.
 */

describe('difficultyIsEstimated', () => {
  it('calls a trail with no recorded ascent estimated', () => {
    expect(difficultyIsEstimated(0)).toBe(true)
  })

  it('does not call a trail with a measured climb estimated', () => {
    expect(difficultyIsEstimated(700)).toBe(false)
    expect(difficultyIsEstimated('1250')).toBe(false)
  })

  /*
   * The column is NOT NULL and has always held 0 for "nobody measured", so a
   * genuinely flat trail reads as estimated here too. That is the right way
   * round: calling a flat trail's grade an estimate is a small inaccuracy,
   * while calling a mountain's grade measured is the defect itself.
   */
  it('treats anything unreadable as unmeasured rather than as flat', () => {
    for (const value of [null, undefined, '', 'n/a', Number.NaN, -40])
      expect(difficultyIsEstimated(value), String(value)).toBe(true)
  })
})

describe('difficultyLabel', () => {
  it('marks an estimated grade with a tilde', () => {
    expect(difficultyLabel('moderate', 0)).toBe('~moderate')
  })

  it('leaves a measured grade alone', () => {
    expect(difficultyLabel('hard', 3200)).toBe('hard')
  })

  /*
   * An empty grade stays empty rather than becoming a lone tilde, which would
   * render as a badge saying nothing at all.
   */
  it('returns nothing for a trail with no grade', () => {
    expect(difficultyLabel('', 0)).toBe('')
    expect(difficultyLabel(null, 0)).toBe('')
    expect(difficultyLabel(undefined, 500)).toBe('')
  })
})

describe('difficultyTitle', () => {
  it('explains the tilde', () => {
    const title = difficultyTitle('moderate', 0)
    expect(title).toContain('Estimated from distance')
    expect(title).toContain('ascent has not been measured')
  })

  /*
   * Empty for a measured grade, so the badge carries no tooltip promising an
   * explanation it does not need.
   */
  it('says nothing about a measured grade', () => {
    expect(difficultyTitle('hard', 3200)).toBe('')
  })

  it('says nothing when there is no grade at all', () => {
    expect(difficultyTitle('', 0)).toBe('')
  })
})

describe('the label and the mark agree', () => {
  /*
   * Two functions reading the same signal, so a badge cannot show a tilde
   * while the data says measured, or the reverse.
   */
  it('tildes exactly the grades it calls estimated', () => {
    for (const elevation of [0, -1, null, 1, 700, 5000, Number.NaN]) {
      const estimated = difficultyIsEstimated(elevation)
      expect(difficultyLabel('moderate', elevation).startsWith('~'), String(elevation)).toBe(estimated)
      expect(difficultyTitle('moderate', elevation) !== '', String(elevation)).toBe(estimated)
    }
  })
})

describe('the label survives the trip to a template', () => {
  /*
   * The regression guard for how this first went wrong.
   *
   * `normalizeTrailsPayload` builds `UiTrail` as an explicit allow-list, so a
   * field the API adds and it does not name is dropped before any template
   * sees it. The badge rendered blank for exactly that reason, and nothing
   * failed — the API was right, the function was right, and the object in
   * between quietly had no such property.
   */
  const payload = (elevation: number) => ({
    trails: [{
      id: 1,
      name: 'Mist Trail',
      location: 'Yosemite Valley, CA',
      difficulty: 'moderate',
      distance: 2.67,
      elevation,
      // The normalizer drops a row it cannot place on the map.
      latitude: 37.7265,
      longitude: -119.5429,
    }],
  })

  it('carries a label a template can read without calling anything', () => {
    const { trails } = normalizeTrailsPayload(payload(1000))
    expect(trails).toHaveLength(1)
    expect(trails[0].difficultyLabel).toBe('moderate')
    expect(trails[0].difficultyEstimated).toBe(false)
  })

  it('marks the estimate through the same path', () => {
    const { trails } = normalizeTrailsPayload(payload(0))
    expect(trails[0].difficultyLabel).toBe('~moderate')
    expect(trails[0].difficultyEstimated).toBe(true)
  })
})

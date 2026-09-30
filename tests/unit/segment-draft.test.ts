import type { DraftSample } from '../../resources/functions/segment-draft'
import { describe, expect, it } from 'bun:test'
import {
  cumulativeMiles,
  MAX_SEGMENT_POINTS,
  MIN_SEGMENT_MILES,
  segmentDraft,
} from '../../resources/functions/segment-draft'
import { matchSegment } from '../../resources/functions/segment-matching'

/**
 * Cutting a segment out of a run somebody already did.
 *
 * The property that matters most is the last one here: a segment drawn from a
 * track has to be one the matcher then finds in that same track. Anything else
 * is a segment nobody can ever set a time on, including the person who made it.
 */

const METRES_PER_DEGREE_LAT = 111_320
const BASE = { lat: 37.8, lng: -122.5 }

function at(northMetres: number, eastMetres = 0) {
  const lngScale = 111_320 * Math.cos(BASE.lat * Math.PI / 180)
  return { lat: BASE.lat + northMetres / METRES_PER_DEGREE_LAT, lng: BASE.lng + eastMetres / lngScale }
}

/** A run north, one fix every `stepMetres`, climbing `ftPerFix`. */
function run(fixes: number, stepMetres = 20, ftPerFix = 0): DraftSample[] {
  return Array.from({ length: fixes }, (_, i) => ({ ...at(i * stepMetres), eleFt: 100 + i * ftPerFix }))
}

describe('segmentDraft', () => {
  it('cuts a segment out of the middle of a run', () => {
    const result = segmentDraft(run(400), 100, 300, 'Headlands Climb')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // 200 fixes at 20 m is 4 km, about 2.5 miles.
    expect(result.draft.distance).toBeGreaterThan(2)
    expect(result.draft.distance).toBeLessThan(3)
    expect(result.draft.name).toBe('Headlands Climb')
  })

  it('measures ascent over the slice, not the whole activity', () => {
    // Climbing a foot per fix: the middle two hundred should be about 200 ft,
    // not the 400 the whole run gains.
    const result = segmentDraft(run(400, 20, 1), 100, 300, 'Middle')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.draft.elevation).toBeGreaterThan(150)
    expect(result.draft.elevation).toBeLessThan(250)
  })

  it('derives the box from the line it stores', () => {
    const result = segmentDraft(run(400), 100, 300, 'Boxed')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const { draft } = result
    for (const [lat, lng] of draft.geometry) {
      expect(lat).toBeGreaterThanOrEqual(draft.minLat)
      expect(lat).toBeLessThanOrEqual(draft.maxLat)
      expect(lng).toBeGreaterThanOrEqual(draft.minLng)
      expect(lng).toBeLessThanOrEqual(draft.maxLng)
    }
    expect(draft.startLat).toBe(draft.geometry[0][0])
    expect(draft.endLat).toBe(draft.geometry[draft.geometry.length - 1][0])
  })

  describe('what it refuses', () => {
    it('refuses a segment with no name', () => {
      expect(segmentDraft(run(400), 100, 300, '   ')).toEqual({ ok: false, reason: 'no-name' })
    })

    it('refuses a selection that ends before it starts', () => {
      expect(segmentDraft(run(400), 300, 100, 'Backwards')).toEqual({ ok: false, reason: 'backwards' })
      expect(segmentDraft(run(400), 100, 100, 'Nothing')).toEqual({ ok: false, reason: 'backwards' })
    })

    /*
     * Below a tenth of a mile the matcher's 25-metre corridor is a meaningful
     * fraction of the segment, so whether somebody ran it stops being a
     * question about the ground and becomes one about GPS error.
     */
    it('refuses a segment too short to time', () => {
      // Five fixes twenty metres apart is 100 m, well under the minimum.
      expect(segmentDraft(run(400), 0, 5, 'Sprint')).toEqual({ ok: false, reason: 'too-short' })
    })

    it('refuses a selection with too few points to have a shape', () => {
      // Two fixes is a straight line between two places, which the matcher
      // refuses anyway — a segment of one leg accepts anything passing both ends.
      expect(segmentDraft(run(400), 0, 1, 'Two points')).toEqual({ ok: false, reason: 'too-few-points' })
      // Three indices apart but only two usable fixes between them.
      const sparse: DraftSample[] = [at(0), { lat: Number.NaN, lng: Number.NaN }, at(5000)]
      expect(segmentDraft(sparse, 0, 2, 'Broken')).toEqual({ ok: false, reason: 'too-few-points' })
    })
  })

  describe('the stored line', () => {
    it('thins a long selection without losing either end', () => {
      const samples = run(5000)
      const result = segmentDraft(samples, 0, 4999, 'Long one')
      expect(result.ok).toBe(true)
      if (!result.ok) return

      expect(result.draft.geometry.length).toBeLessThanOrEqual(MAX_SEGMENT_POINTS)
      // The finish is what the matcher times an effort to, so it must be the
      // actual last fix rather than whichever one the stride landed on.
      const last = samples[4999]
      expect(result.draft.endLat).toBeCloseTo(last.lat, 5)
      expect(result.draft.endLng).toBeCloseTo(last.lng, 5)
    })

    it('keeps a short selection whole', () => {
      const result = segmentDraft(run(400), 100, 200, 'Short')
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.draft.geometry).toHaveLength(101)
    })
  })

  /*
   * The property the whole feature rests on.
   *
   * A segment cut from a track must be one the matcher finds in that track —
   * otherwise somebody draws a climb from their own run and it never appears
   * on the board, which is the shape of a feature that looks finished and does
   * nothing.
   */
  describe('a segment drawn from a run is a segment that run matches', () => {
    const timed = (samples: DraftSample[], secondsApart = 5) =>
      samples.map((sample, i) => ({ lat: sample.lat, lng: sample.lng, time: 1_790_000_000_000 + i * secondsApart * 1000 }))

    it('matches the activity it was cut from', () => {
      const samples = run(400)
      const result = segmentDraft(samples, 100, 300, 'Cut from this')
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const efforts = matchSegment(
        timed(samples),
        result.draft.geometry.map(([lat, lng]) => ({ lat, lng })),
      )
      expect(efforts).toHaveLength(1)
      expect(efforts[0].elapsedSeconds).toBeGreaterThan(0)
    })

    it('matches even when the line had to be thinned', () => {
      const samples = run(5000, 5)
      const result = segmentDraft(samples, 0, 4999, 'Thinned')
      expect(result.ok).toBe(true)
      if (!result.ok) return

      const efforts = matchSegment(
        timed(samples),
        result.draft.geometry.map(([lat, lng]) => ({ lat, lng })),
      )
      expect(efforts).toHaveLength(1)
    })
  })
})

describe('cumulativeMiles', () => {
  it('says how far into the run each fix is', () => {
    const miles = cumulativeMiles(run(400))
    expect(miles).toHaveLength(400)
    expect(miles[0]).toBe(0)
    for (let i = 1; i < miles.length; i++)
      expect(miles[i]).toBeGreaterThanOrEqual(miles[i - 1])
  })

  it('agrees with the distance a segment cut there would have', () => {
    // The creation UI shows "from 2.4 to 3.9 mi" while somebody drags the
    // ends. If that preview used a different measure from the saved segment,
    // the number would change on save.
    const samples = run(400)
    const miles = cumulativeMiles(samples)
    const result = segmentDraft(samples, 100, 300, 'Preview')
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.draft.distance).toBeCloseTo(miles[300] - miles[100], 1)
  })

  it('does not advance across a fix it cannot place', () => {
    const miles = cumulativeMiles([at(0), { lat: Number.NaN, lng: Number.NaN }, at(0)])
    expect(miles[1]).toBe(miles[0])
  })

  it('is at least the minimum a segment needs, for a long enough slice', () => {
    const miles = cumulativeMiles(run(400))
    expect(miles[399]).toBeGreaterThan(MIN_SEGMENT_MILES)
  })
})

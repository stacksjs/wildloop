import { describe, expect, it } from 'bun:test'
import {
  coverageOf,
  isRealPhoto,
  percent,
  sampleWindows,
} from '../../app/Support/catalogCoverage'

/**
 * Measuring the catalog in a way that can be measured again.
 *
 * #1002's original figures were taken by hand against the live API at offsets
 * 0, 60k, 200k and 400k. Neither half of that survives: the default ordering
 * changed when the browse band landed, so offset 0 selects different trails,
 * and paging past roughly 60,000 now answers 520 (#1008). Re-running it
 * produced 321 hard trails against a baseline of 69 — not a catalog that got
 * harder, two samples of different trails.
 */

const isStock = (url: string) => url.includes('unsplash')

describe('sampleWindows', () => {
  it('spreads the sample evenly across the id space', () => {
    expect(sampleWindows(1, 101, 5)).toEqual([1, 21, 41, 61, 81])
  })

  /*
   * By id rather than by offset, and evenly rather than randomly: two runs a
   * month apart have to land on the same trails, or the difference between
   * them says nothing about the catalog.
   */
  it('returns the same windows every time for the same bounds', () => {
    expect(sampleWindows(1, 596_556, 8)).toEqual(sampleWindows(1, 596_556, 8))
  })

  it('handles a table with one id, and nonsense bounds', () => {
    expect(sampleWindows(7, 7, 10)).toEqual([7])
    expect(sampleWindows(100, 1, 5)).toEqual([])
    expect(sampleWindows(1, 100, 0)).toEqual([])
    expect(sampleWindows(Number.NaN, 100, 5)).toEqual([])
  })

  it('never asks for more windows than requested', () => {
    expect(sampleWindows(1, 1000, 400)).toHaveLength(400)
  })
})

describe('isRealPhoto', () => {
  it('counts a sourced photograph', () => {
    expect(isRealPhoto('https://commons.wikimedia.org/wiki/Special:FilePath/Alum_Cave_Trail_1.jpg', isStock)).toBe(true)
  })

  it('does not count the stock filler it is meant to replace', () => {
    expect(isRealPhoto('https://images.unsplash.com/photo-1448375240586', isStock)).toBe(false)
  })

  it('does not count an absent photo as a real one', () => {
    expect(isRealPhoto(null, isStock)).toBe(false)
    expect(isRealPhoto('', isStock)).toBe(false)
    expect(isRealPhoto('   ', isStock)).toBe(false)
  })
})

describe('coverageOf', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    elevation: 0,
    rating: 0,
    review_count: 0,
    image: 'https://images.unsplash.com/photo-1448375240586',
    dogs_allowed: null,
    surface: '',
    difficulty: 'easy',
    ...over,
  })

  it('counts what the sample carries', () => {
    const report = coverageOf([
      row({ elevation: 1200, rating: 4.5, review_count: 3, image: 'https://commons.wikimedia.org/x.jpg', surface: 'dirt', difficulty: 'hard' }),
      row({ elevation: 300, surface: 'gravel' }),
      row(),
    ], isStock)

    expect(report.sampled).toBe(3)
    expect(report.fields.elevation).toBe(2)
    expect(report.fields.rating).toBe(1)
    expect(report.fields.reviews).toBe(1)
    expect(report.fields.realPhoto).toBe(1)
    expect(report.fields.stockPhoto).toBe(2)
    expect(report.fields.surface).toBe(2)
    expect(report.difficulty).toEqual({ hard: 1, easy: 2 })
  })

  /*
   * Zero elevation is absent, not flat. The column is NOT NULL and zero is
   * what it holds for "nobody measured" — the same distinction #1004 turns on,
   * and counting it as coverage would report the gap as closed.
   */
  it('does not count a zero elevation as measured', () => {
    expect(coverageOf([row({ elevation: 0 })], isStock).fields.elevation).toBe(0)
  })

  it('separates no photo at all from stock filler', () => {
    const report = coverageOf([row({ image: null }), row({ image: '' }), row()], isStock)
    expect(report.fields.noPhoto).toBe(2)
    expect(report.fields.stockPhoto).toBe(1)
    expect(report.fields.realPhoto).toBe(0)
  })

  /*
   * `dogs_allowed` is a tri-state: true, false, and nobody recorded it. A
   * recorded "no dogs" is coverage — it answers the question somebody opened
   * the page to ask.
   */
  it('counts a recorded "no" as a dogs policy', () => {
    expect(coverageOf([row({ dogs_allowed: false })], isStock).fields.dogsPolicy).toBe(1)
    expect(coverageOf([row({ dogs_allowed: null })], isStock).fields.dogsPolicy).toBe(0)
  })

  it('reports an empty sample without dividing by it', () => {
    const report = coverageOf([], isStock)
    expect(report.sampled).toBe(0)
    expect(report.fields.elevation).toBe(0)
    expect(percent(0, 0)).toBe('—')
  })
})

describe('percent', () => {
  it('reads the way the baseline does', () => {
    expect(percent(77, 535)).toBe('14.4%')
    expect(percent(233, 400)).toBe('58.3%')
    expect(percent(0, 400)).toBe('0.0%')
  })
})

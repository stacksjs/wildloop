import { describe, expect, it } from 'bun:test'
import { shouldFallbackToCatalog } from '../../resources/composables/useTrailCatalog'
import {
  activeFilterCount,
  bucketChipLabel,
  emptyFilters,
  filtersFromQuery,
  filtersToQuery,
  LENGTH_BUCKETS,
} from '../../resources/composables/useTrailFilters'

describe('filters to query', () => {
  it('sends nothing at all when nothing is filtered', () => {
    expect(filtersToQuery(emptyFilters())).toEqual({})
    expect(activeFilterCount(emptyFilters())).toBe(0)
  })

  it('turns a length bucket into both bounds', () => {
    expect(filtersToQuery({ ...emptyFilters(), length: '2-5' })).toEqual({ minDistance: 2, maxDistance: 5 })
  })

  it('leaves an open end unbounded', () => {
    expect(filtersToQuery({ ...emptyFilters(), length: 'under-2' })).toEqual({ maxDistance: 2 })
    expect(filtersToQuery({ ...emptyFilters(), length: 'over-30' })).toEqual({ minDistance: 30 })
  })

  it('carries ascent, rating and suitability', () => {
    const query = filtersToQuery({
      ...emptyFilters(),
      elevation: '1000-2500',
      rating: 4,
      dogsAllowed: true,
      accessible: true,
      nationalTrail: true,
    })

    expect(query).toEqual({
      minElevation: 1000,
      maxElevation: 2500,
      minRating: 4,
      dogsAllowed: true,
      accessible: true,
      nationalTrail: true,
    })
  })

  it('counts every filter that is doing something', () => {
    expect(activeFilterCount({ ...emptyFilters(), difficulty: 'hard', length: '2-5', rating: 4 })).toBe(3)
  })
})

describe('filter chips', () => {
  it('reads as the chosen value, and as the control name otherwise', () => {
    expect(bucketChipLabel(LENGTH_BUCKETS, 'any', 'Length')).toBe('Length')
    expect(bucketChipLabel(LENGTH_BUCKETS, '5-10', 'Length')).toBe('5 – 10 mi')
    expect(bucketChipLabel(LENGTH_BUCKETS, 'nonsense', 'Length')).toBe('Length')
  })
})

describe('filters from a url', () => {
  it('restores a shared list', () => {
    const filters = filtersFromQuery({ difficulty: 'moderate', length: '2-5', rating: '4', dogs: 'true' })

    expect(filters.difficulty).toBe('moderate')
    expect(filters.length).toBe('2-5')
    expect(filters.rating).toBe(4)
    expect(filters.dogsAllowed).toBe(true)
  })

  it('ignores a value it does not know rather than filtering to nothing', () => {
    const filters = filtersFromQuery({ difficulty: 'brutal', length: '900-1000', rating: '9' })

    expect(filters).toEqual(emptyFilters())
  })
})

describe('near-me fallback with the new filters', () => {
  const empty = { trails: [], geometryById: {}, total: 0, hasMore: false }

  it('keeps a deliberate bound empty instead of dropping the location', () => {
    expect(shouldFallbackToCatalog({ lat: 37.8, lng: -119.5, minDistance: 10 }, empty)).toBe(false)
    expect(shouldFallbackToCatalog({ lat: 37.8, lng: -119.5, minRating: 4 }, empty)).toBe(false)
    expect(shouldFallbackToCatalog({ lat: 37.8, lng: -119.5, dogsAllowed: true }, empty)).toBe(false)
  })

  it('still broadens a plain location-only search', () => {
    expect(shouldFallbackToCatalog({ lat: 10.3, lng: 123.9 }, empty)).toBe(true)
  })
})

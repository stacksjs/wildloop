import { describe, expect, it } from 'bun:test'
import { shouldFallbackToCatalog, type TrailQuery, type TrailQueryResult } from '../../resources/composables/useTrailCatalog'

const emptyResult: TrailQueryResult = { trails: [], geometryById: {}, total: 0, hasMore: false, country: null }

describe('trail search fallback', () => {
  it('broadens an empty location-only catalog search', () => {
    const query: TrailQuery = { lat: 10.3157, lng: 123.8854, radius: 25, sort: 'rating' }

    expect(shouldFallbackToCatalog(query, emptyResult)).toBe(true)
  })

  it('keeps deliberate filters and typed searches empty', () => {
    expect(shouldFallbackToCatalog({ lat: 10.3157, lng: 123.8854, q: 'Cebu trail' }, emptyResult)).toBe(false)
    expect(shouldFallbackToCatalog({ lat: 10.3157, lng: 123.8854, country: 'US' }, emptyResult)).toBe(false)
    expect(shouldFallbackToCatalog({ lat: 10.3157, lng: 123.8854, difficulty: 'hard' }, emptyResult)).toBe(false)
  })

  it('does not broaden a location search that has a result', () => {
    const result: TrailQueryResult = { ...emptyResult, trails: [{ id: 1 } as any], total: 1 }

    expect(shouldFallbackToCatalog({ lat: 10.3157, lng: 123.8854 }, result)).toBe(false)
  })
})

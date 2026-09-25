import { describe, expect, it } from 'bun:test'
import { orderRegions, regionDistanceLabel } from '../../resources/functions/region-order'

const REGIONS = [
  { code: 'NY', name: 'New York', country: 'US', count: 9000, lat: 42.9, lng: -75.5 },
  { code: 'CA', name: 'California', country: 'US', count: 5000, lat: 36.8, lng: -119.4 },
  { code: 'NV', name: 'Nevada', country: 'US', count: 800, lat: 39.3, lng: -116.6 },
  { code: 'XX', name: 'Nowhere', country: 'US', count: 20000, lat: null, lng: null },
]

const SANTA_MONICA = { lat: 34.02, lng: -118.49 }

describe('orderRegions', () => {
  it('puts the nearest regions first when it knows where the visitor is', () => {
    const ordered = orderRegions(REGIONS, SANTA_MONICA)
    expect(ordered.map(r => r.code)).toEqual(['CA', 'NV', 'NY', 'XX'])
    expect(ordered[0].miles).toBeGreaterThan(100)
    expect(ordered[0].miles).toBeLessThan(250)
    // A region with no centre is listed, not dropped, and has no distance.
    expect(ordered[3].miles).toBeNull()
  })

  it('falls back to biggest first without a location', () => {
    expect(orderRegions(REGIONS, null).map(r => r.code)).toEqual(['XX', 'NY', 'CA', 'NV'])
    expect(orderRegions(REGIONS, { lat: Number.NaN, lng: 0 }).map(r => r.code)).toEqual(['XX', 'NY', 'CA', 'NV'])
  })

  it('does not reorder the caller\'s array', () => {
    const rows = [...REGIONS]
    orderRegions(rows, SANTA_MONICA)
    expect(rows.map(r => r.code)).toEqual(['NY', 'CA', 'NV', 'XX'])
  })
})

describe('regionDistanceLabel', () => {
  it('reads as miles, and as Nearest for the closest region close by', () => {
    expect(regionDistanceLabel(2412.4)).toBe('2,412 mi')
    expect(regionDistanceLabel(96, true)).toBe('Nearest')
    expect(regionDistanceLabel(400, true)).toBe('400 mi')
    expect(regionDistanceLabel(null)).toBe('')
  })
})

import { describe, expect, it } from 'bun:test'
import { mapArea } from '../../resources/functions/map-area'

describe('mapArea', () => {
  it('covers the whole view: centre to corner', () => {
    // Santa Monica to a corner ~10 mi north-east.
    const area = mapArea({ lat: 34.02, lng: -118.49 }, { lat: 34.12, lng: -118.37 })
    expect(area.lat).toBe(34.02)
    expect(area.lng).toBe(-118.49)
    expect(area.radius).toBeGreaterThanOrEqual(9)
    expect(area.radius).toBeLessThanOrEqual(11)
  })

  it('stays within what the API searches', () => {
    expect(mapArea({ lat: 34, lng: -118 }, { lat: 34.0001, lng: -118 }).radius).toBe(1)
    expect(mapArea({ lat: 25, lng: -125 }, { lat: 49, lng: -67 }).radius).toBe(300)
  })
})

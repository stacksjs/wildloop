import { describe, expect, it } from 'bun:test'
import { mapArea, mapBoundsAround, mapBoundsContain, mapBoundsFromQuery } from '../../resources/functions/map-area'

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

describe('mapBoundsFromQuery', () => {
  const query = (values: Record<string, unknown>) => (key: string) => values[key]

  it('reads the corners a query string carries, which are strings', () => {
    expect(mapBoundsFromQuery(query({ min_lat: '33.7', min_lng: '-118.7', max_lat: '34.3', max_lng: '-118.0' })))
      .toEqual({ minLat: 33.7, minLng: -118.7, maxLat: 34.3, maxLng: -118 })
  })

  it('is null when the request asked for no area', () => {
    expect(mapBoundsFromQuery(query({}))).toBeNull()
    expect(mapBoundsFromQuery(query({ min_lat: '33.7', min_lng: '-118.7', max_lat: '34.3' }))).toBeNull()
  })

  it('refuses corners off the globe, or the wrong way round', () => {
    expect(mapBoundsFromQuery(query({ min_lat: '-95', min_lng: '0', max_lat: '1', max_lng: '1' }))).toBeNull()
    expect(mapBoundsFromQuery(query({ min_lat: '2', min_lng: '0', max_lat: '1', max_lng: '1' }))).toBeNull()
    expect(mapBoundsFromQuery(query({ min_lat: 'north', min_lng: '0', max_lat: '1', max_lng: '1' }))).toBeNull()
  })
})

describe('mapBoundsAround', () => {
  it('reaches the radius in every direction', () => {
    const la = { lat: 34.05, lng: -118.25 }
    const box = mapBoundsAround(la, 25)
    expect(mapBoundsContain(box, 34.25, -118.25)).toBe(true)
    expect(mapBoundsContain(box, 34.05, -118.5)).toBe(true)
    expect(mapBoundsContain(box, 37.77, -122.42)).toBe(false)
  })
})

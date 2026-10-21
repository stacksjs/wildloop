import { describe, expect, it } from 'bun:test'
import { EXPLORE_MAX_RADIUS, EXPLORE_MIN_RADIUS, exploreMarkers, exploreMovedFar, exploreRadius, exploreRegionFor } from '../../resources/functions/trail-explore'

const portland = { center: { latitude: 45.52, longitude: -122.68 }, span: { latitudeDelta: 1, longitudeDelta: 1 } }

describe('the trail map around you', () => {
  it('asks for the trails the visible map covers', () => {
    // Half a degree of latitude is about 35 miles; longitude is narrower here.
    expect(exploreRadius(portland)).toBe(35)
  })

  it('keeps the radius inside what the API accepts', () => {
    expect(exploreRadius({ ...portland, span: { latitudeDelta: 0.001, longitudeDelta: 0.001 } })).toBe(EXPLORE_MIN_RADIUS)
    expect(exploreRadius({ ...portland, span: { latitudeDelta: 40, longitudeDelta: 60 } })).toBe(EXPLORE_MAX_RADIUS)
    expect(exploreRadius({ ...portland, span: { latitudeDelta: Number.NaN, longitudeDelta: 1 } })).toBe(EXPLORE_MIN_RADIUS)
  })

  it('offers "Search this area" after a real move or zoom, not a nudge', () => {
    expect(exploreMovedFar(null, portland)).toBe(true)
    expect(exploreMovedFar(portland, { ...portland, center: { latitude: 45.6, longitude: -122.68 } })).toBe(false)
    expect(exploreMovedFar(portland, { ...portland, center: { latitude: 46, longitude: -122.68 } })).toBe(true)
    expect(exploreMovedFar(portland, { ...portland, span: { latitudeDelta: 0.3, longitudeDelta: 0.3 } })).toBe(true)
  })

  it('pins only the trails with a trailhead', () => {
    expect(exploreMarkers([
      { id: 7, name: 'Eagle Creek', lat: 45.64, lng: -121.92 },
      { id: 8, name: 'Nowhere', lat: 0, lng: 0 },
      { id: 9, name: 'No position' },
    ])).toEqual([{ id: 7, title: 'Eagle Creek', geometry: [45.64, -121.92] }])
  })

  it('frames every pin, and a lone one with room around it', () => {
    const both = exploreRegionFor([{ id: 1, title: 'a', geometry: [45, -122] }, { id: 2, title: 'b', geometry: [46, -121] }])
    expect(both?.center).toEqual({ latitude: 45.5, longitude: -121.5 })
    expect(both?.span.latitudeDelta).toBeCloseTo(1.3)
    const lone = exploreRegionFor([{ id: 1, title: 'a', geometry: [45, -122] }])
    expect(lone?.span).toEqual({ latitudeDelta: 0.08, longitudeDelta: 0.08 })
    expect(exploreRegionFor([])).toBeNull()
  })
})

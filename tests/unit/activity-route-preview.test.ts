import { describe, expect, it } from 'bun:test'
import { activityRoutePreview, ROUTE_PREVIEW_POINTS, thinRoute } from '../../app/Support/activityRoutePreview'

/** A straight 2 km line north, one point every ~22 m. */
const TRACK = Array.from({ length: 91 }, (_, index) => ({ lat: 34 + index * 0.0002, lng: -118.5 }))
const OWNER = 7

function context(viewerId: number | null, hide = 400) {
  return { viewerId, trailGeometry: new Map<number, unknown>(), hideMetres: new Map([[OWNER, hide]]) }
}

describe('activityRoutePreview', () => {
  const activity = { id: 1, user_id: OWNER, trail_id: null, gpx_data: JSON.stringify(TRACK) }

  it('draws the athlete\'s own route whole', () => {
    const route = activityRoutePreview(activity, context(OWNER))
    expect(route[0]).toEqual([TRACK[0].lat, TRACK[0].lng])
    expect(route.at(-1)).toEqual([TRACK.at(-1)!.lat, TRACK.at(-1)!.lng])
    expect(route.length).toBeLessThanOrEqual(ROUTE_PREVIEW_POINTS)
  })

  it('blurs the start and finish for anybody else', () => {
    for (const viewer of [null, 99]) {
      const route = activityRoutePreview(activity, context(viewer))
      expect(route.length).toBeGreaterThan(1)
      // ~400 m trimmed from each end: well clear of the real start and finish.
      expect(route[0][0]).toBeGreaterThan(TRACK[0].lat + 0.003)
      expect(route.at(-1)![0]).toBeLessThan(TRACK.at(-1)!.lat - 0.003)
    }
  })

  it('draws nothing rather than the unmasked line when masking leaves too little', () => {
    const short = { ...activity, gpx_data: JSON.stringify(TRACK.slice(0, 10)) }
    expect(activityRoutePreview(short, context(99))).toEqual([])
  })

  it('falls back to the trail\'s main line for a manual entry', () => {
    const manual = { id: 2, user_id: OWNER, trail_id: 5, gpx_data: null }
    const ctx = context(OWNER)
    ctx.trailGeometry.set(5, JSON.stringify([[34, -118], [34.01, -118.01], [34.02, -118]]))
    expect(activityRoutePreview(manual, ctx)).toEqual([[34, -118], [34.01, -118.01], [34.02, -118]])
    expect(activityRoutePreview({ ...manual, trail_id: 6 }, ctx)).toEqual([])
  })
})

describe('thinRoute', () => {
  it('keeps both ends and at most the limit', () => {
    const thinned = thinRoute(TRACK, 10)
    expect(thinned).toHaveLength(10)
    expect(thinned[0]).toBe(TRACK[0])
    expect(thinned.at(-1)).toBe(TRACK.at(-1))
    expect(thinRoute(TRACK.slice(0, 5), 10)).toHaveLength(5)
  })
})

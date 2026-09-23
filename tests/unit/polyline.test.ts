import { describe, expect, it } from 'bun:test'
import { decodePolyline, encodePolyline } from '../../resources/functions/polyline'

describe('encoded polylines', () => {
  it('matches the reference encoding', () => {
    // The worked example from Google's polyline algorithm documentation.
    const points: [number, number][] = [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]]
    expect(encodePolyline(points)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@')
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual(points)
  })

  it('round-trips a route to within a metre', () => {
    const route: [number, number][] = Array.from({ length: 300 }, (_, i) => [32.9209 + i * 0.000123, -117.2528 - i * 0.0000871])
    const back = decodePolyline(encodePolyline(route))
    expect(back).toHaveLength(300)
    for (let i = 0; i < route.length; i++) {
      expect(Math.abs(back[i][0] - route[i][0])).toBeLessThan(0.00001)
      expect(Math.abs(back[i][1] - route[i][1])).toBeLessThan(0.00001)
    }
    expect(encodePolyline(route).length).toBeLessThan(300 * 8)
  })

  it('stops at the last whole point of a malformed string', () => {
    expect(decodePolyline('')).toEqual([])
    expect(decodePolyline('_p~iF~ps|U_ulL')).toEqual([[38.5, -120.2]])
    expect(decodePolyline('  \n')).toEqual([])
  })
})

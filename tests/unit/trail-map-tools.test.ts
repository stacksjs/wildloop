import { describe, expect, it } from 'bun:test'
import { trailDirectionSigns, trailDirectionVisibility, trailGpx, trailheadPosition, trailSurfaceTypes } from '../../resources/functions/trail-map'

describe('trailhead navigation', () => {
  it('uses the recorded route start instead of its catalog center', () => {
    expect(trailheadPosition([[37.73282,-119.55778],[37.72614,-119.53038]],{lat:37.726737,lng:-119.542904})).toEqual({lat:37.73282,lng:-119.55778})
  })
  it('uses the primary recorded section without joining disconnected lines', () => {
    expect(trailheadPosition([[[34,-118],[34.001,-118]],[[35,-119],[35.1,-119]]])).toEqual({lat:35,lng:-119})
  })
  it('retains a valid catalog location only when no route is recorded', () => {
    expect(trailheadPosition(null,{lat:0,lng:0})).toEqual({lat:0,lng:0})
    expect(trailheadPosition(null,{lat:NaN,lng:0})).toBeNull()
    expect(trailheadPosition(null,{lat:91,lng:0})).toBeNull()
    expect(trailheadPosition(null)).toBeNull()
  })
})

describe('route direction signs', () => {
  it('spaces signs along the route and points in the travel direction', () => {
    const signs = trailDirectionSigns([[[34, -118], [34.01, -118], [34.01, -117.99]]], 3)
    expect(signs).toHaveLength(3)
    expect(signs[0].bearing).toBeCloseTo(0)
    expect(signs[2].bearing).toBeCloseTo(90, 1)
    for (const sign of signs)
      expect(sign.point[0] === 34.01 || sign.point[1] === -118).toBe(true)
  })

  it('never places signs across disconnected sections', () => {
    const signs = trailDirectionSigns([[[0, 0], [0, 0.01]], [[1, 1], [1, 1.01]]], 8)
    expect(signs).toHaveLength(8)
    for (const sign of signs)
      expect(sign.point[0] === 0 || sign.point[0] === 1).toBe(true)
  })

  it('handles zero length and duplicate vertices', () => {
    expect(trailDirectionSigns([[[1, 1], [1, 1]]])).toEqual([])
    expect(trailDirectionSigns([[[1, 1], [1, 1], [1.01, 1]]], 2)).toHaveLength(2)
    expect(trailDirectionSigns([])).toEqual([])
  })
})

describe('direction badge spacing on screen', () => {
  it('keeps a short vertical route legible and reveals more badges as it grows', () => {
    const compact = Array.from({ length: 14 }, (_, index) => ({ x: 80, y: index * 12 }))
    expect(trailDirectionVisibility(compact).filter(Boolean)).toHaveLength(3)
    expect(trailDirectionVisibility(compact.map(point => ({ x: point.x, y: point.y * 6 }))).every(Boolean)).toBe(true)
  })

  it('avoids collisions across crossing route sections and rejects invalid projections', () => {
    expect(trailDirectionVisibility([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 2, y: 2 }, { x: NaN, y: 20 }])).toEqual([true, true, false, false])
    expect(trailDirectionVisibility([])).toEqual([])
  })
})

describe('surface types', () => {
  it('groups equivalent surfaces and preserves unknown catalog values', () => {
    expect(trailSurfaceTypes('dirt;asphalt;ground;wood;compacted_gravel').map(s => s.label)).toEqual(['Natural', 'Paved', 'Wood', 'Compacted gravel'])
    expect(trailSurfaceTypes(null)).toEqual([])
  })
})

describe('GPX export', () => {
  it('escapes the trail name and keeps gaps as separate track segments', () => {
    const gpx = trailGpx('Fern & <Pine>', [[[34, -118], [34.01, -118]], [[35, -118], [35.01, -118]]])
    expect(gpx).toContain('<name>Fern &amp; &lt;Pine&gt;</name>')
    expect(gpx.match(/<trkseg>/g)).toHaveLength(2)
    expect(gpx).toContain('<trkpt lat="34" lon="-118"/>')
  })
})

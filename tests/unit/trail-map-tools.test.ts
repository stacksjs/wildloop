import { describe, expect, it } from 'bun:test'
import { trailDirectionSigns, trailGpx, trailSurfaceTypes } from '../../resources/functions/trail-map'

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

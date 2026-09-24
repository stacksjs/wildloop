import { describe, expect, it } from 'bun:test'
import { applyTrailAreaPhoto } from '../../app/Support/trailAreaPhotos'
import { normalizeTrailRow } from '../../resources/assets/scripts/trail-data'

const stock = 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=800&h=600&fit=crop'
const arch = {
  id: 1,
  source: 'nps',
  source_id: 'nps/CHIS|ARCH POINT LOOP TRAIL',
  latitude: 33.48291,
  longitude: -119.033499,
  image: stock,
}

describe('reviewed Santa Barbara Island area photos', () => {
  it('marks a matched catalog cover as an area image through UI normalization', () => {
    const trail = normalizeTrailRow(applyTrailAreaPhoto(arch))
    expect(trail?.image).toContain('Special:FilePath/Santabarbara_300.jpg')
    expect(trail?.coverScope).toBe('area')
    expect(trail?.coverPlace).toBe('Santa Barbara Island')
    expect(trail?.coverCredit).toBe('Shane Anderson/NOAA')
  })

  it('does not replace editor photos or attach to namesakes in other places', () => {
    const editor = 'https://example.com/editor.jpg'
    expect(applyTrailAreaPhoto({ ...arch, image: editor }).image).toBe(editor)
    expect(applyTrailAreaPhoto({ ...arch, source: 'osm' }).image).toBe(stock)
    expect(applyTrailAreaPhoto({ ...arch, latitude: 34.0 }).image).toBe(stock)
    expect(applyTrailAreaPhoto({ ...arch, source_id: 'nps/OTHER|ARCH POINT LOOP TRAIL' }).image).toBe(stock)
  })
})

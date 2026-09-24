import { describe, expect, it } from 'bun:test'
import { applyCommunityCovers, trailsNeedingCommunityCover } from '../../app/Support/trailCovers'

const stock = 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=800&h=600&fit=crop'

describe('community trail covers', () => {
  it('only requests safe ids for trails with stock or no image', () => {
    expect(trailsNeedingCommunityCover([
      { id: 1, image: stock },
      { id: 2, image: null },
      { id: 3, image: 'https://example.com/curated.jpg' },
      { id: -1, image: stock },
      { id: Number.NaN, image: stock },
    ])).toEqual([1, 2])
  })

  it('uses a trail-specific thumbnail and preserves curated images', () => {
    const trails = [
      { id: 1, image: stock, name: 'One' },
      { id: 2, image: null, name: 'Two' },
      { id: 3, image: 'https://example.com/curated.jpg', name: 'Three' },
    ]
    const covers = [
      { trail_id: 1, uuid: 'photo-one', user_name: ' Ada ' },
      { trail_id: 2, uuid: 'photo-two', user_name: null },
      { trail_id: 3, uuid: 'photo-three', user_name: 'Grace' },
    ]
    expect(applyCommunityCovers(trails, covers)).toEqual([
      { id: 1, image: '/api/trail-photos/1/photo-one-thumb.jpg', coverCredit: 'Ada', name: 'One' },
      { id: 2, image: '/api/trail-photos/2/photo-two-thumb.jpg', coverCredit: '', name: 'Two' },
      trails[2],
    ])
    expect(trails[0].image).toBe(stock)
  })
})

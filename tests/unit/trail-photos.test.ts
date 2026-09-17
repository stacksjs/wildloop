import { describe, expect, it } from 'bun:test'
import { parsePhotoList, trailGallery } from '../../resources/functions/trail-photos'

describe('photo parsing', () => {
  it('reads every shape the column has held', () => {
    expect(parsePhotoList('["https://a.test/1.jpg","https://a.test/2.jpg"]')).toEqual(['https://a.test/1.jpg', 'https://a.test/2.jpg'])
    expect(parsePhotoList('https://a.test/1.jpg, https://a.test/2.jpg')).toEqual(['https://a.test/1.jpg', 'https://a.test/2.jpg'])
    expect(parsePhotoList(['/uploads/1.jpg'])).toEqual(['/uploads/1.jpg'])
    expect(parsePhotoList('https://a.test/1.jpg')).toEqual(['https://a.test/1.jpg'])
  })

  it('drops anything that is not plainly an image URL', () => {
    expect(parsePhotoList('javascript:alert(1)')).toEqual([])
    expect(parsePhotoList('//evil.test/x.jpg')).toEqual([])
    expect(parsePhotoList('data:image/png;base64,AAAA')).toEqual([])
    expect(parsePhotoList(null)).toEqual([])
    expect(parsePhotoList(42)).toEqual([])
  })

  it('recovers a malformed array rather than showing nothing', () => {
    expect(parsePhotoList('[https://a.test/1.jpg,')).toEqual([])
    expect(parsePhotoList('https://a.test/1.jpg,')).toEqual(['https://a.test/1.jpg'])
  })
})

describe('trail gallery', () => {
  it('leads with the trail image and credits the rest', () => {
    const gallery = trailGallery(
      { image: 'https://a.test/cover.jpg', name: 'Canyon Overlook' },
      [{ photos: 'https://a.test/1.jpg', userName: 'Ada' }],
    )

    expect(gallery).toEqual([
      { url: 'https://a.test/cover.jpg', credit: '', illustrative: false },
      { url: 'https://a.test/1.jpg', credit: 'Ada', illustrative: false },
    ])
  })

  it('marks a stock cover as illustrative, at whatever size it was requested', () => {
    const cover = 'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1600&h=900&fit=crop'
    const [first] = trailGallery({ image: cover }, [])
    expect(first).toEqual({ url: cover, credit: '', illustrative: true })
  })

  it('shows one copy of a photo posted twice', () => {
    const gallery = trailGallery({ image: 'https://a.test/1.jpg' }, [
      { photos: 'https://a.test/1.jpg', userName: 'Ada' },
      { photos: 'https://a.test/2.jpg', userName: 'Grace' },
    ])

    expect(gallery.map(photo => photo.url)).toEqual(['https://a.test/1.jpg', 'https://a.test/2.jpg'])
  })

  it('caps a popular trail at twelve frames', () => {
    const reviews = Array.from({ length: 30 }, (_, i) => ({ photos: `https://a.test/${i}.jpg`, userName: 'Ada' }))
    expect(trailGallery({ image: null }, reviews)).toHaveLength(12)
  })

  it('is empty when there is nothing to show', () => {
    expect(trailGallery(null, [])).toEqual([])
    expect(trailGallery({ image: '' }, [{ photos: null }])).toEqual([])
  })
})

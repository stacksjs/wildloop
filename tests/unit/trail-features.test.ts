import { describe, expect, it } from 'bun:test'
import {
  featureFromTag,
  normalizeTagKey,
  readTags,
  routeTypeLabel,
  trailFeatures,
  trailHighlight,
  trailNotices,
} from '../../resources/functions/trail-features'

describe('tag normalization', () => {
  it('folds spacing, casing and separators into one key', () => {
    expect(normalizeTagKey('Dog Friendly')).toBe('dog-friendly')
    expect(normalizeTagKey('dog_friendly')).toBe('dog-friendly')
    expect(normalizeTagKey('  DOG-FRIENDLY  ')).toBe('dog-friendly')
  })

  it('reads both stored shapes and drops duplicates', () => {
    expect(readTags({ tags: 'Waterfall, waterfall , views' })).toEqual(['waterfall', 'views'])
    expect(readTags({ tags: ['Forest', 'forest'] })).toEqual(['forest'])
    expect(readTags({ tags: null })).toEqual([])
  })

  it('labels an unknown tag rather than dropping it', () => {
    expect(featureFromTag('gravel-road')).toEqual({ key: 'gravel-road', label: 'Gravel Road', icon: '' })
    expect(featureFromTag('   ')).toBeNull()
  })
})

describe('trail features', () => {
  it('includes the booleans the catalog stores outside the tag string', () => {
    const features = trailFeatures({ tags: ['waterfall'], dogsAllowed: true, nationalTrail: true })
    expect(features.map(f => f.key)).toEqual(['dog-friendly', 'national-trail', 'waterfall'])
  })

  it('does not repeat an attribute carried both ways', () => {
    const features = trailFeatures({ tags: ['dogs'], dogsAllowed: true })
    expect(features.map(f => f.key)).toEqual(['dog-friendly'])
  })

  it('says nothing about a boolean the catalog has no answer for', () => {
    expect(trailFeatures({ dogsAllowed: null, wheelchairAccessible: undefined })).toEqual([])
  })
})

describe('trail highlight', () => {
  it('picks the tag a decision is made on over a classification', () => {
    expect(trailHighlight({ tags: ['forest', 'kids'], nationalTrail: true })?.label).toBe('Kid-friendly')
  })

  it('matches aliases', () => {
    expect(trailHighlight({ tags: ['falls'] })?.key).toBe('waterfall')
  })

  it('offers nothing when there is nothing to say', () => {
    expect(trailHighlight({ tags: [] })).toBeNull()
  })
})

describe('route type', () => {
  it('reads as a phrase, not a slug', () => {
    expect(routeTypeLabel('out-and-back')).toBe('Out & back')
    expect(routeTypeLabel('loop')).toBe('Loop')
    expect(routeTypeLabel('')).toBe('')
  })
})

describe('trail notices', () => {
  it('warns about a ban, never about an unknown', () => {
    expect(trailNotices({ dogsAllowed: false }).map(n => n.key)).toEqual(['no-dogs'])
    expect(trailNotices({ dogsAllowed: null })).toEqual([])
  })

  it('flags a route long enough to need overnights', () => {
    const keys = trailNotices({ distance: 4600, elevation: 232000 }).map(n => n.key)
    expect(keys).toContain('multi-day')
    expect(keys).toContain('steep')
  })

  it('leads with the warnings a day hike would care about', () => {
    const notices = trailNotices({ dogsAllowed: false, routeType: 'point-to-point' }, { hasRoute: false })
    expect(notices[0].key).toBe('no-dogs')
    expect(notices.map(n => n.key)).toContain('no-route')
    expect(notices.map(n => n.key)).toContain('shuttle')
  })

  it('says nothing for an ordinary day hike with a route line', () => {
    expect(trailNotices({ distance: 1, elevation: 213, routeType: 'out-and-back' }, { hasRoute: true })).toEqual([])
  })
})

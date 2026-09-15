import { describe, expect, it } from 'bun:test'
import { deepLinkPath } from '../../resources/composables/useNativeServices'

describe('native deep-link routing', () => {
  it('maps host-style and path-style custom URLs to the same local route', () => {
    expect(deepLinkPath('wildloop://record')).toBe('/record')
    expect(deepLinkPath('wildloop:///record')).toBe('/record')
    expect(deepLinkPath('wildloop://trail/42?source=share#map')).toBe('/trail/42?source=share#map')
  })

  it('accepts Craft’s native deep-link event detail', () => {
    expect(deepLinkPath({ url: 'wildloop://record' })).toBe('/record')
    expect(deepLinkPath({ url: 'wildloop://trail/42?source=share#map' })).toBe('/trail/42?source=share#map')
    expect(deepLinkPath({ url: 42 })).toBeNull()
  })

  it('accepts only WildLoop web links and custom schemes', () => {
    expect(deepLinkPath('https://wildloop.org/record?source=push')).toBe('/record?source=push')
    expect(deepLinkPath('https://example.com/record')).toBeNull()
    expect(deepLinkPath('not a url')).toBeNull()
  })
})

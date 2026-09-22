import { describe, expect, it } from 'bun:test'
import { activeTabFor } from '../../resources/functions/native-tabs'

describe('the tab bar highlight', () => {
  it('lights Feed for the feed and the activities opened from it', () => {
    expect(activeTabFor('/feed')).toBe('/feed')
    expect(activeTabFor('/')).toBe('/feed')
    expect(activeTabFor('/activity/12')).toBe('/feed')
    expect(activeTabFor('/feed.html')).toBe('/feed')
  })

  it('lights Record for the recorder', () => {
    expect(activeTabFor('/record')).toBe('/record')
  })

  it('lights Menu for everything the Menu holds, and anything else', () => {
    for (const path of ['/menu', '/trails', '/trail/4', '/territories', '/achievements', '/settings', '/profile', '/clubs', '/recordings'])
      expect(activeTabFor(path)).toBe('/menu')
  })

  it('lights nothing on Search, which belongs to no tab', () => {
    expect(activeTabFor('/search')).toBeNull()
  })
})

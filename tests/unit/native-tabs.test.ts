import { describe, expect, it } from 'bun:test'
import { activeTabFor } from '../../resources/functions/native-tabs'

describe('the tab bar highlight', () => {
  it('lights Feed for the feed and the activities opened from it', () => {
    expect(activeTabFor('/feed')).toBe('/feed')
    expect(activeTabFor('/')).toBe('/feed')
    expect(activeTabFor('/activity/12')).toBe('/feed')
    expect(activeTabFor('/feed.html')).toBe('/feed')
  })

  it('lights Discover for the trail list it opens', () => {
    expect(activeTabFor('/trails')).toBe('/trails')
    expect(activeTabFor('/trails.html')).toBe('/trails')
  })

  it('lights Record for the recorder', () => {
    expect(activeTabFor('/record')).toBe('/record')
  })

  it('lights Menu for everything the Menu holds, and anything else', () => {
    for (const path of ['/menu', '/trail/4', '/territories', '/achievements', '/settings', '/profile', '/clubs', '/recordings'])
      expect(activeTabFor(path)).toBe('/menu')
  })

  it('lights nothing on the pages no tab opens', () => {
    // Search comes from the top bar and the map from the round accessory
    // beside the tab pill. Lighting Me for either says the account is open.
    expect(activeTabFor('/search')).toBeNull()
    expect(activeTabFor('/explore')).toBeNull()
  })

  it('names a tab for every tab the bar renders', async () => {
    // The highlight went stale once already: Discover was added to the bar on
    // 20 Oct 2026 and this module, written a month earlier, still knew three
    // tabs, so the new tab never lit and /trails lit Me instead. Read the hrefs
    // out of the layout so the next tab cannot land the same way.
    const layout = await Bun.file(new URL('../../resources/layouts/default.stx', import.meta.url)).text()
    const bar = layout.slice(layout.indexOf('<NativeTabBar'), layout.indexOf('</NativeTabBar>'))
    const hrefs = [...bar.matchAll(/<NativeTabItem[^>]*href="([^"]+)"/g)].map(match => match[1])

    expect(hrefs.length).toBeGreaterThan(0)
    for (const href of hrefs)
      expect(activeTabFor(href)).toBe(href)
  })
})

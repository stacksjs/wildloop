import { describe, expect, it } from 'bun:test'
import {
  APP_SHORTCUTS,
  appShortcut,
  appShortcutDeepLink,
  appShortcutRoute,
  craftShortcutItems,
} from '../../resources/functions/app-shortcuts'
import { deepLinkPath } from '../../resources/composables/useNativeServices'

describe('the shortcut catalogue', () => {
  it('carries the three the product has an answer for', () => {
    expect(APP_SHORTCUTS.map(shortcut => shortcut.id)).toEqual(['favorites', 'trails-near-me', 'view-stats'])
  })

  it('stays short enough for the surfaces that show it', () => {
    // iOS shows four quick actions at most, and Spotlight's row fewer.
    expect(APP_SHORTCUTS.length).toBeLessThanOrEqual(4)
    for (const shortcut of APP_SHORTCUTS) {
      expect(shortcut.title.length).toBeLessThanOrEqual(20)
      expect(shortcut.phrase.toLowerCase()).toContain('wildloop')
      expect(shortcut.symbol).toMatch(/^[a-z0-9.]+$/)
    }
  })

  it('has one id per shortcut, since the id is what iOS stores', () => {
    expect(new Set(APP_SHORTCUTS.map(s => s.id)).size).toBe(APP_SHORTCUTS.length)
  })

  it('looks a shortcut up, and says so when it has none', () => {
    expect(appShortcut('view-stats')?.route).toBe('/stats')
    expect(appShortcut('nonsense')).toBeNull()
    expect(appShortcutRoute('favorites')).toBe('/profile?tab=saved')
    expect(appShortcutRoute('nonsense')).toBeNull()
  })
})

describe('the deep link a shortcut opens', () => {
  it('round-trips through the app’s own deep-link routing', () => {
    // The contract that keeps the native surfaces and the web routes in step:
    // rename a route on one side and this fails on the other.
    for (const shortcut of APP_SHORTCUTS)
      expect(deepLinkPath(appShortcutDeepLink(shortcut))).toBe(shortcut.route)
  })

  it('builds the host-style URL iOS hands back', () => {
    expect(appShortcutDeepLink(appShortcut('trails-near-me')!)).toBe('wildloop://trails?near=me')
    expect(appShortcutDeepLink(appShortcut('view-stats')!)).toBe('wildloop://stats')
  })

  it('takes the scheme the build actually registered', () => {
    expect(appShortcutDeepLink(appShortcut('view-stats')!, 'wildloop-dev')).toBe('wildloop-dev://stats')
  })
})

describe('the Craft bridge payload', () => {
  it('is the shape `shortcuts.set` takes, with the link along for the tap', () => {
    expect(craftShortcutItems()[0]).toEqual({
      type: 'favorites',
      title: 'Favorites',
      subtitle: 'Trails you saved',
      iconName: 'heart.fill',
      userInfo: { url: 'wildloop://profile?tab=saved' },
    })
  })

  it('offers every shortcut, and every link it carries routes', () => {
    const items = craftShortcutItems()
    expect(items).toHaveLength(APP_SHORTCUTS.length)
    for (const item of items)
      expect(deepLinkPath(item.userInfo.url)).toBe(appShortcutRoute(item.type))
  })
})

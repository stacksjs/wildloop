import { beforeAll, describe, expect, it } from 'bun:test'
import mobile from '../../config/mobile'
import { compileNativeBundle, nativeKeychain, start } from '../fixtures/nativeScreen'
import { BARE_SCREENS, ME_TAB, nativeChrome, nativeHeaderFrom } from '../../resources/functions/native-chrome'

/**
 * The tab bar and bar buttons every signed-in screen shares, in HQ's shape:
 * four tabs with the account on the last, a calendar on the left, the shared
 * actions on the right, and the round button beside the pill - here the map.
 */
describe('the app chrome', () => {
  it('has HQ\'s four tabs, with the account last', () => {
    expect(mobile.ios.tabs.map(tab => [tab.id, tab.title, tab.symbol])).toEqual([
      ['/feed', 'Feed', 'house'],
      ['/trails', 'Discover', 'magnifyingglass'],
      ['/record', 'Record', 'record.circle'],
      [ME_TAB, 'Me', 'person.crop.circle'],
    ])
    expect(mobile.android.tabs).toEqual(mobile.ios.tabs)
  })

  it('opens the trail map from the round button beside the tabs', () => {
    expect(nativeChrome(null).tabAccessory).toEqual({ path: '/explore', title: 'Map', symbol: 'map', accessibilityLabel: 'Trail map' })
    expect(mobile.ios.nativeScreens['/explore']).toBe('Explore')
  })

  it('puts the same buttons on every screen, each opening a screen the app has', () => {
    const chrome = nativeChrome(null)
    const buttons = [...chrome.leftButtons!, ...chrome.rightButtons!]
    expect(buttons.map(button => [button.id, button.symbol, button.open])).toEqual([
      ['plans', 'calendar', '/plans'],
      ['stats', 'chart.xyaxis.line', '/stats'],
      ['notifications', 'bell', '/notifications'],
    ])
    // Each opens a screen the app has, and is left off that screen by name.
    for (const button of buttons)
      expect(button.hideOn).toEqual([mobile.ios.nativeScreens[button.open as keyof typeof mobile.ios.nativeScreens]])
    expect(chrome.bare).toEqual([...BARE_SCREENS])
  })

  it('wears the account on the Me tab: its picture, or the person symbol, and the unread count', () => {
    const pictured = nativeChrome({ userId: 3, name: 'Dana Fixture', avatar: 'https://cdn.wildloop.org/a.jpg', notificationsUnread: 4 })
    expect(pictured.tabItems).toEqual([{ id: ME_TAB, title: 'Me', image: 'https://cdn.wildloop.org/a.jpg', badge: '4', accessibilityLabel: 'Me, 4 unread notifications' }])
    expect(pictured.rightButtons!.find(button => button.id === 'notifications')).toMatchObject({ badge: 4, badgeStyle: 'count' })

    const initials = nativeChrome({ userId: 3, name: 'Dana Fixture', avatar: null, notificationsUnread: 0 })
    expect(initials.tabItems![0]).toMatchObject({ image: null, badge: null, accessibilityLabel: 'Me' })
    expect(initials.tabItems![0]).not.toHaveProperty('iconText')
    expect(nativeChrome({ userId: 3, name: 'x', avatar: null, notificationsUnread: 250 }).tabItems![0].badge).toBe('99+')
  })

  it('reads the header from /api/me, refusing what it cannot show', () => {
    expect(nativeHeaderFrom({ id: 3, name: ' Dana ', avatar: 'https://cdn.wildloop.org/a.jpg' }, 2)).toEqual({ userId: 3, name: 'Dana', avatar: 'https://cdn.wildloop.org/a.jpg', notificationsUnread: 2 })
    // The bar only loads https pictures; anything else is the initials.
    expect(nativeHeaderFrom({ id: 3, name: 'Dana', avatar: 'http://cdn.test/a.jpg' }, -1)).toEqual({ userId: 3, name: 'Dana', avatar: null, notificationsUnread: 0 })
    expect(nativeHeaderFrom({ id: 0 }, 0)).toBeNull()
    expect(nativeHeaderFrom(null, 0)).toBeNull()
  })
})

describe('the chrome on a compiled screen', () => {
  beforeAll(compileNativeBundle, 30000)

  const optionsSent = (screen: Awaited<ReturnType<typeof start>>) => screen.sent.filter((message: any) => message.type === 'NAVIGATION_SET_OPTIONS').map((message: any) => message.payload)

  async function settled(screen: Awaited<ReturnType<typeof start>>, done: (sent: any[]) => boolean) {
    for (let attempt = 0; attempt < 60 && !done(optionsSent(screen)); attempt++) await Bun.sleep(1)
    return optionsSent(screen)
  }

  it('reaches the host from a signed-in screen: the buttons, the Me tab and the map', async () => {
    const screen = await start('Stats')
    const sent = await settled(screen, all => all.some(options => options.tabAccessory))
    expect(sent.find(options => options.rightButtons)?.rightButtons.map((button: any) => button.id)).toEqual(['notifications'])
    expect(sent.find(options => options.leftButtons)?.leftButtons.map((button: any) => button.id)).toEqual(['plans'])
    expect(sent.find(options => options.tabItem)?.tabItem).toMatchObject({ id: ME_TAB, title: 'Me' })
    expect(sent.find(options => options.tabAccessory)?.tabAccessory).toMatchObject({ path: '/explore', symbol: 'map' })
    // Nothing the host cannot carry: no callbacks, no chrome-only fields.
    for (const button of sent.flatMap(options => [...(options.leftButtons ?? []), ...(options.rightButtons ?? [])])) {
      expect(button).not.toHaveProperty('open')
      expect(button).not.toHaveProperty('onPress')
    }
  })

  it('stays off the sign-in screens', async () => {
    const screen = await start('Login', {}, undefined, {}, nativeKeychain(null))
    for (let attempt = 0; attempt < 30; attempt++) await Bun.sleep(1)
    expect(optionsSent(screen).some(options => options.tabAccessory || options.rightButtons?.length)).toBe(false)
  })
})

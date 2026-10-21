import type { NativeCraft, NativeNavigationChrome } from '@stacksjs/stx/native'

/**
 * The bar buttons and tabs every signed-in screen shares, the way HQ's do.
 *
 * Across the top: Plans on the left, Stats and Notifications on the right, the
 * way HQ carries Calendar, Progress and Store. The Me tab wears the account's
 * picture and its unread count, as HQ's does. Where HQ keeps Messages in the
 * round button beside the tab pill, Wildloop keeps the map: every trail
 * around you, with search (`/explore`).
 *
 * The merging - a screen's own buttons first, a button left off the screen it
 * opens, bare screens, nothing resent that did not change - is stx's
 * `navigation.setChrome`. What is here is only what Wildloop puts in it.
 */

/** What the bar and the Me tab show of the account, published once by the app script. */
export const NATIVE_HEADER_SNAPSHOT = 'wildloop-header'

export interface NativeHeader {
  userId: number
  name: string
  /** An https picture, or null for the initials. */
  avatar: string | null
  notificationsUnread: number
}

/** The tab the account lives on. */
export const ME_TAB = '/menu'

/**
 * Screens that keep only their own buttons: someone else's page with its own
 * actions, a full-screen map, the recorder mid-activity.
 */
export const BARE_SCREENS = ['Profile', 'AthleteDetail', 'ClubDetail', 'EventDetail', 'TrailMap', 'Explore', 'Record'] as const

/** The header from `/api/me` and the notifications count, or null when either is unusable. */
export function nativeHeaderFrom(user: unknown, unread: unknown): NativeHeader | null {
  const record = user as { id?: unknown, name?: unknown, avatar?: unknown } | null
  const id = Number(record?.id)
  if (!Number.isSafeInteger(id) || id < 1) return null
  const avatar = typeof record?.avatar === 'string' && record.avatar.startsWith('https://') ? record.avatar : null
  return { userId: id, name: String(record?.name ?? '').trim(), avatar, notificationsUnread: Math.max(0, Math.floor(Number(unread) || 0)) }
}

function count(unread: number): string | null {
  if (unread <= 0) return null
  return unread > 99 ? '99+' : String(unread)
}

/** The chrome for the account the header describes; with no header, the buttons without a badge. */
export function nativeChrome(header: NativeHeader | null): NativeNavigationChrome {
  const unread = header?.notificationsUnread ?? 0
  return {
    leftButtons: [
      { id: 'plans', symbol: 'calendar', variant: 'neutral', accessibilityLabel: 'Plans', open: '/plans', hideOn: ['Plans'] },
    ],
    rightButtons: [
      { id: 'stats', symbol: 'chart.xyaxis.line', variant: 'neutral', accessibilityLabel: 'Stats', open: '/stats', hideOn: ['Stats'] },
      { id: 'notifications', symbol: 'bell', variant: 'neutral', accessibilityLabel: unread ? `Notifications, ${unread} unread` : 'Notifications', badge: unread, badgeStyle: 'count', open: '/notifications', hideOn: ['Notifications'] },
    ],
    bare: [...BARE_SCREENS],
    tabItems: [{
      id: ME_TAB,
      title: 'Me',
      // The picture when there is one, otherwise the configured person
      // symbol, as HQ's Me tab does: initials drawn in the tab's tint read as
      // an error badge.
      image: header?.avatar ?? null,
      badge: count(unread),
      accessibilityLabel: unread ? `Me, ${unread} unread notifications` : 'Me',
    }],
    tabAccessory: { path: '/explore', title: 'Map', symbol: 'map', accessibilityLabel: 'Trail map' },
  }
}

type ChromeHost = Pick<NativeCraft, 'navigation' | 'snapshots'>

const installed = new WeakSet<object>()

/**
 * Give this screen the app's chrome and keep it current. Once per screen, so
 * the guard that calls it on every appearance does not stack listeners.
 */
export function installNativeChrome(host: ChromeHost): void {
  if (installed.has(host) || typeof host.navigation.setChrome !== 'function') return
  installed.add(host)
  const apply = () => host.navigation.setChrome(nativeChrome(host.snapshots.get<NativeHeader>(NATIVE_HEADER_SNAPSHOT) ?? null))
  apply()
  host.snapshots.onChange((name) => {
    if (name === NATIVE_HEADER_SNAPSHOT) apply()
  })
}

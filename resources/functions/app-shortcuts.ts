/**
 * The app's shortcuts: the few things somebody opens Wildloop to do, named
 * once and reused by every surface that can offer them.
 *
 * iOS surfaces these in three places, all fed from this one list:
 *
 *   - Spotlight's Top Hit row and Siri, through the App Intents generated into
 *     the iOS project (scripts/generate-ios-shortcuts.ts).
 *   - The home-screen long-press menu, through Craft's `shortcuts` bridge.
 *   - Siri Suggestions, through the donated activity each carries.
 *
 * Every one of them ends at a `wildloop://` deep link, which is the path the
 * app already knows how to route (see useNativeServices). That is what keeps
 * the three surfaces honest: a shortcut cannot open a screen the web app does
 * not have, and `appShortcutDeepLink` is checked against `deepLinkPath` in the
 * tests so a route renamed on one side fails on the other.
 */

export interface AppShortcut {
  /**
   * Stable identity, used as the iOS shortcut item `type`, the Siri action and
   * the generated intent's name. Changing one renames a shortcut somebody may
   * have added to their home screen, so these are not cosmetic.
   */
  id: string
  /** What the shortcut is called. Kept to two words: iOS truncates hard. */
  title: string
  /** One line under the title, where the surface has room for it. */
  subtitle: string
  /** SF Symbol name. The system draws it; no asset ships for it. */
  symbol: string
  /** Where it opens, as an app route including any query. */
  route: string
  /** What somebody would say to Siri. Includes the app name, as Apple asks. */
  phrase: string
}

/**
 * The three the product actually has an answer for.
 *
 * Deliberately short. iOS shows four quick actions at most and Spotlight's row
 * fewer still, and a shortcut list that mirrors the whole navigation is a menu
 * rather than a shortcut.
 */
export const APP_SHORTCUTS: AppShortcut[] = [
  {
    id: 'favorites',
    title: 'Favorites',
    subtitle: 'Trails you saved',
    symbol: 'heart.fill',
    route: '/profile?tab=saved',
    phrase: 'Show my favorites in Wildloop',
  },
  {
    id: 'trails-near-me',
    title: 'Trails Near Me',
    subtitle: 'What is close by',
    symbol: 'map.fill',
    route: '/trails?near=me',
    phrase: 'Find trails near me with Wildloop',
  },
  {
    id: 'view-stats',
    title: 'View Stats',
    subtitle: 'Your miles and ascent',
    symbol: 'chart.bar.fill',
    route: '/stats',
    phrase: 'Show my stats in Wildloop',
  },
]

export function appShortcut(id: string): AppShortcut | null {
  return APP_SHORTCUTS.find(shortcut => shortcut.id === id) ?? null
}

/** The route a shortcut opens, or null for one this build does not carry. */
export function appShortcutRoute(id: string): string | null {
  return appShortcut(id)?.route ?? null
}

/**
 * A shortcut as the URL that opens it.
 *
 * Host-style (`wildloop://trails?near=me`) rather than path-style, because
 * that is the form iOS hands back from `UIApplication.open` and the form
 * `deepLinkPath` has always read.
 */
export function appShortcutDeepLink(shortcut: AppShortcut, scheme = 'wildloop'): string {
  return `${scheme}://${shortcut.route.replace(/^\//, '')}`
}

/** One shortcut in the shape Craft's `shortcuts.set` bridge takes. */
export interface CraftShortcutItem {
  type: string
  title: string
  subtitle: string
  iconName: string
  /** Carried through the tap, so the handler knows where to go. */
  userInfo: { url: string }
}

/**
 * The home-screen quick actions, ready for the bridge.
 *
 * The deep link travels in `userInfo` rather than being derived from the type
 * on the other side: the native handler should not have to hold a copy of this
 * list to know what a shortcut means.
 */
export function craftShortcutItems(scheme = 'wildloop'): CraftShortcutItem[] {
  return APP_SHORTCUTS.map(shortcut => ({
    type: shortcut.id,
    title: shortcut.title,
    subtitle: shortcut.subtitle,
    iconName: shortcut.symbol,
    userInfo: { url: appShortcutDeepLink(shortcut, scheme) },
  }))
}

/**
 * Which bottom tab a page belongs to, for the tab bar's highlight.
 *
 * The bar has four tabs and the Menu holds everything else, so the Menu is
 * the home of any page the other three do not claim: a trail opened from the
 * Menu, Settings, a club. An activity belongs to the Feed it is opened from.
 *
 * A trail's own page stays on the Menu rather than following Discover: it is
 * opened from the Menu, from the Feed and from a club as often as from the
 * trail list, so there is no one tab it came from.
 */

export type NativeTab = '/feed' | '/trails' | '/record' | '/menu'

const FEED_PATHS = ['/', '/feed', '/activity']
const TRAILS_PATHS = ['/trails']
const RECORD_PATHS = ['/record']

/**
 * Pages that belong to no tab, so none lights while they are open. Search is
 * opened from the top bar of the Feed or the Menu, and the trail map from the
 * round button beside the tab pill (`tabAccessory` in native-chrome) — an
 * accessory is not a tab, and lighting Me for it says the account is open.
 */
const TABLESS_PATHS = ['/search', '/explore']

function within(path: string, roots: string[]): boolean {
  return roots.some(root => (root === '/' ? path === '/' : path === root || path.startsWith(`${root}/`)))
}

export function activeTabFor(pathname: string): NativeTab | null {
  const path = pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '') || '/'
  if (within(path, TABLESS_PATHS))
    return null
  if (within(path, FEED_PATHS))
    return '/feed'
  if (within(path, TRAILS_PATHS))
    return '/trails'
  if (within(path, RECORD_PATHS))
    return '/record'
  return '/menu'
}

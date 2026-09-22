/**
 * Which bottom tab a page belongs to, for the tab bar's highlight.
 *
 * The bar has three tabs and the Menu holds everything else, so the Menu is
 * the home of any page the other two do not claim: a trail opened from the
 * Menu, Settings, a club. An activity belongs to the Feed it is opened from.
 */

export type NativeTab = '/feed' | '/record' | '/menu'

const FEED_PATHS = ['/', '/feed', '/activity']
const RECORD_PATHS = ['/record']

function within(path: string, roots: string[]): boolean {
  return roots.some(root => (root === '/' ? path === '/' : path === root || path.startsWith(`${root}/`)))
}

export function activeTabFor(pathname: string): NativeTab {
  const path = pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '') || '/'
  if (within(path, FEED_PATHS))
    return '/feed'
  if (within(path, RECORD_PATHS))
    return '/record'
  return '/menu'
}

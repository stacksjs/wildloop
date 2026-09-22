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

export function activeTabFor(pathname: string): NativeTab | null {
  const path = pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '') || '/'
  // Search is opened from the top bar of the Feed or the Menu, and belongs to
  // neither; no tab lights while it is open.
  if (path === '/search')
    return null
  if (within(path, FEED_PATHS))
    return '/feed'
  if (within(path, RECORD_PATHS))
    return '/record'
  return '/menu'
}

/**
 * Shared destinations for the native Menu and the website's phone menu.
 *
 * `symbol` feeds `<Icon :name>` on the native screen, and stx resolves that
 * name **lucide-first**: a bare word is looked up in `LUCIDE_TO_SF`, and only
 * a name containing a dot is passed through to UIKit as an SF Symbol
 * (`resolveIconName`, @stacksjs/stx/native). Anything else draws a plain
 * `circle`. So a perfectly valid bare SF Symbol name that lucide has no word
 * for is silently wrong: on a device, 19 Oct 2026, Settings, Leaderboard,
 * Battles and Conquests each showed an empty circle, for `gearshape`, `crown`,
 * `bolt` and `scope` — all four of which `UIImage(systemName:)` resolves
 * perfectly well when asked directly.
 *
 * Three had a lucide word that reaches the same symbol (`settings`→gearshape,
 * `zap`→bolt, `target`→scope). The 240-entry table has no crown at all, so
 * that one goes through the dotted escape hatch as `crown.fill`.
 * `tests/unit/mobile-menu-icons.test.ts` runs every one of these through
 * stx's own resolver, so the next unreachable name fails there rather than on
 * somebody's phone.
 */
export const MOBILE_MENU_GROUPS = [
  { title: 'Explore', items: [
    { label: 'Trails', href: '/trails', icon: 'i-lucide-map', symbol: 'map' },
    { label: 'Plans', href: '/plans', icon: 'i-lucide-calendar-days', symbol: 'calendar', account: true },
    { label: 'Draw a route', href: '/routes', icon: 'i-lucide-route', symbol: 'point.topleft.down.to.point.bottomright.curvepath', account: true },
    { label: 'Saved trails', href: '/trails?list=saved', icon: 'i-lucide-heart', symbol: 'heart', account: true },
    { label: 'Completed trails', href: '/trails?list=completed', icon: 'i-lucide-circle-check', symbol: 'checkmark.circle', account: true },
  ] },
  { title: 'You', items: [
    { label: 'Your profile', href: '/profile', icon: 'i-lucide-user-round', symbol: 'person.crop.circle', account: true },
    { label: 'Achievements', href: '/achievements', icon: 'i-lucide-trophy', symbol: 'trophy', account: true },
    { label: 'Stats', href: '/stats', icon: 'i-lucide-chart-column', symbol: 'chart.bar', account: true },
    { label: 'Notifications', href: '/notifications', icon: 'i-lucide-bell', symbol: 'bell', account: true },
  ] },
  { title: 'Compete', items: [
    { label: 'Territory', href: '/territories', icon: 'i-lucide-flag', symbol: 'flag', account: true },
    { label: 'Leaderboard', href: '/leaderboard', icon: 'i-lucide-crown', symbol: 'crown.fill' },
    { label: 'Battles', href: '/battles', icon: 'i-lucide-swords', symbol: 'zap' },
    { label: 'Conquests', href: '/conquests', icon: 'i-lucide-target', symbol: 'target', account: true },
    { label: 'Challenges', href: '/challenges', icon: 'i-lucide-medal', symbol: 'medal', account: true },
    { label: 'Records', href: '/records', icon: 'i-lucide-timer', symbol: 'timer' },
  ] },
  { title: 'People', items: [
    { label: 'Find athletes', href: '/athletes', icon: 'i-lucide-user-search', symbol: 'person.2' },
    { label: 'Clubs', href: '/clubs', icon: 'i-lucide-users', symbol: 'person.3' },
    { label: 'Events', href: '/events', icon: 'i-lucide-calendar-days', symbol: 'calendar' },
  ] },
  // Settings sits apart from 'You' because it is the one row here a signed-out
  // viewer can still use: it carries About and the legal pages, and offers a
  // guest a Log in button rather than an empty account panel. Under 'You' it
  // would leave that heading standing over a single row for a guest, which is
  // the kind of account talk a guest has no use for. The web menu already
  // renders it in its own trailing card for the same reason.
  { title: 'App', items: [
    { label: 'Settings', href: '/settings', icon: 'i-lucide-settings', symbol: 'settings' },
  ] },
] as const

/** One destination. `account` marks the ones that answer 401 without a bearer. */
export interface MobileMenuItem {
  label: string
  href: string
  icon: string
  symbol: string
  account?: boolean
}

/**
 * The menu as a given viewer can actually use it.
 *
 * Twelve of the nineteen destinations answer 401 without a bearer, so a
 * signed-out viewer who opens Territory, Achievements or Plans gets an empty
 * screen and no explanation — measured against the dev API on 19 Oct 2026.
 * They are dropped rather than shown-and-gated: a menu is a list of places you
 * can go.
 *
 * Settings stays, because it is the only way to About and the legal pages and
 * it already degrades by itself — it offers a guest a Log in button and hides
 * the account sections. Trails, Leaderboard, Battles, Records, Find athletes,
 * Clubs and Events all answer without a token, so they stay too.
 *
 * A group with nothing left in it does not render, which is what removes the
 * 'You' heading rather than leaving it standing over one row.
 */
export function mobileMenuGroups(signedIn: boolean): { title: string, items: MobileMenuItem[] }[] {
  if (signedIn)
    return MOBILE_MENU_GROUPS.map(group => ({ title: group.title, items: [...group.items] }))
  return MOBILE_MENU_GROUPS
    .map(group => ({ title: group.title, items: group.items.filter(item => !('account' in item && item.account)) }))
    .filter(group => group.items.length > 0)
}

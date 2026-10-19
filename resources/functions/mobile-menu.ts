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
    { label: 'Plans', href: '/plans', icon: 'i-lucide-calendar-days', symbol: 'calendar' },
    { label: 'Draw a route', href: '/routes', icon: 'i-lucide-route', symbol: 'point.topleft.down.to.point.bottomright.curvepath' },
    { label: 'Saved trails', href: '/trails?list=saved', icon: 'i-lucide-heart', symbol: 'heart' },
    { label: 'Completed trails', href: '/trails?list=completed', icon: 'i-lucide-circle-check', symbol: 'checkmark.circle' },
  ] },
  { title: 'You', items: [
    { label: 'Your profile', href: '/profile', icon: 'i-lucide-user-round', symbol: 'person.crop.circle' },
    { label: 'Achievements', href: '/achievements', icon: 'i-lucide-trophy', symbol: 'trophy' },
    { label: 'Stats', href: '/stats', icon: 'i-lucide-chart-column', symbol: 'chart.bar' },
    { label: 'Notifications', href: '/notifications', icon: 'i-lucide-bell', symbol: 'bell' },
    { label: 'Settings', href: '/settings', icon: 'i-lucide-settings', symbol: 'settings' },
  ] },
  { title: 'Compete', items: [
    { label: 'Territory', href: '/territories', icon: 'i-lucide-flag', symbol: 'flag' },
    { label: 'Leaderboard', href: '/leaderboard', icon: 'i-lucide-crown', symbol: 'crown.fill' },
    { label: 'Battles', href: '/battles', icon: 'i-lucide-swords', symbol: 'zap' },
    { label: 'Conquests', href: '/conquests', icon: 'i-lucide-target', symbol: 'target' },
    { label: 'Challenges', href: '/challenges', icon: 'i-lucide-medal', symbol: 'medal' },
    { label: 'Records', href: '/records', icon: 'i-lucide-timer', symbol: 'timer' },
  ] },
  { title: 'People', items: [
    { label: 'Find athletes', href: '/athletes', icon: 'i-lucide-user-search', symbol: 'person.2' },
    { label: 'Clubs', href: '/clubs', icon: 'i-lucide-users', symbol: 'person.3' },
    { label: 'Events', href: '/events', icon: 'i-lucide-calendar-days', symbol: 'calendar' },
  ] },
] as const

import { describe, expect, it } from 'bun:test'
import { MOBILE_MENU_GROUPS, mobileMenuGroups } from '../../resources/functions/mobile-menu'

/**
 * What a signed-out viewer is offered.
 *
 * Measured against the dev API on 19 Oct 2026: twelve of the nineteen
 * destinations answer 401 without a bearer. Offering them anyway is what made
 * the menu confusing — a guest taps Territory and gets an empty screen that
 * explains nothing.
 */
const labels = (groups: { items: { label: string }[] }[]) => groups.flatMap(group => group.items.map(item => item.label))

describe('mobileMenuGroups', () => {
  it('offers a guest nothing that needs a bearer', () => {
    expect(labels(mobileMenuGroups(false))).toEqual([
      'Trails',
      'Leaderboard',
      'Battles',
      'Records',
      'Find athletes',
      'Clubs',
      'Events',
      'Settings',
    ])
  })

  /*
   * Every 'You' row is account-only, so the heading goes with them — which is
   * the point: a guest is shown no account talk at all beyond the one sign-in
   * button the screen puts at the top. Settings lives in its own group for
   * exactly this reason; it is the only row here a guest can still use.
   */
  it('drops a group once nothing in it is reachable', () => {
    const titles = mobileMenuGroups(false).map(group => group.title)
    expect(titles).not.toContain('You')
    expect(titles).toEqual(['Explore', 'Compete', 'People', 'App'])
  })

  it('offers a signed-in viewer every destination', () => {
    expect(labels(mobileMenuGroups(true))).toEqual(labels(MOBILE_MENU_GROUPS as any))
    expect(labels(mobileMenuGroups(true))).toHaveLength(19)
  })

  /*
   * The flag is the claim being made about each destination, so it is pinned
   * here rather than only through the filter: a new row that forgets it would
   * be offered to a guest and dead-end them.
   */
  it('marks exactly the destinations that answer 401 without a bearer', () => {
    const marked = MOBILE_MENU_GROUPS.flatMap(group => group.items)
      .filter(item => 'account' in item && item.account)
      .map(item => item.href)
    expect(marked).toEqual([
      '/plans',
      '/routes',
      '/trails?list=saved',
      '/trails?list=completed',
      '/profile',
      '/achievements',
      '/stats',
      '/notifications',
      '/territories',
      '/conquests',
      '/challenges',
    ])
  })
})

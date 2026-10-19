import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileNativeBundle, shownText, start, waitForText, waitForVisibility } from '../fixtures/nativeScreen'

/**
 * The menu, as the two kinds of viewer see it.
 *
 * The app lets a guest browse — trails, the leaderboard, athletes — so the
 * menu it opened on listed nineteen destinations, twelve of which answer 401
 * without a bearer, under a heading that said 'You'. What it pins: a guest is
 * offered only what works plus one way to sign in, and the moment an account
 * arrives the rest of the menu appears without the screen being reopened.
 */
const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Menu.stx'), 'utf8')

describe('Wildloop native menu screen', () => {
  beforeAll(compileNativeBundle, 30000)

  it('renders through the portable keyed boundary', () => {
    expect(SOURCE).toContain('<View :for="group in groups()" :key="group.title"')
    expect(SOURCE).not.toContain('<FlatList')
  })

  it('offers a guest one sign-in and nothing that needs an account', async () => {
    const screen = await start('Menu')
    await waitForText(screen, 'Trails')
    await waitForVisibility(screen, 'menu-signed-out', 'flex')

    const text = shownText(screen).join(' | ')
    expect(text).toContain('Sign in')
    for (const absent of ['Your profile', 'Achievements', 'Notifications', 'Territory', 'Challenges', 'Plans'])
      expect(text).not.toContain(absent)
    // The heading goes with its rows, rather than standing over nothing.
    expect(text).not.toContain('You |')
    // What a guest can actually open is still there.
    for (const offered of ['Trails', 'Leaderboard', 'Battles', 'Records', 'Find athletes', 'Clubs', 'Events', 'Settings'])
      expect(text).toContain(offered)
  })

  /*
   * Signing in happens on another screen. The menu is already mounted when the
   * session lands, so it has to answer the snapshot rather than only what it
   * read on the way in.
   */
  it('fills in the rest of the menu when an account arrives', async () => {
    const screen = await start('Menu')
    await waitForText(screen, 'Trails')
    expect(shownText(screen).join(' | ')).not.toContain('Your profile')

    await screen.scope.craft.snapshots.set('wildloop-session', { user: { id: 7 }, version: 1 })
    await waitForText(screen, 'Your profile')

    const text = shownText(screen).join(' | ')
    for (const offered of ['Your profile', 'Achievements', 'Stats', 'Notifications', 'Territory', 'Conquests', 'Challenges', 'Plans'])
      expect(text).toContain(offered)
    await waitForVisibility(screen, 'menu-signed-out', 'none')
  })

  /*
   * The sign-in button names where it came from, so the login screen returns
   * the viewer to the menu they were reading rather than the feed.
   */
  it('sends the viewer back to the menu after signing in', () => {
    expect(SOURCE).toContain("craft.navigation.open('/login?next=/menu')")
  })
})

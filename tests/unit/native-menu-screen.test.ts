import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answerKeychain, compileNativeBundle, shownText, start, waitForText } from '../fixtures/nativeScreen'

/**
 * The menu, now that there is only one kind of viewer.
 *
 * It used to have two shapes. The app let a guest browse, so the menu listed
 * nineteen destinations, twelve of which answer 401 without a bearer, and it
 * filtered them down to what worked plus one way to sign in. Wildloop needs
 * an account now — login or you do not use the app — so the filtered shape is
 * gone and the guard is what stands in its place.
 */
const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Menu.stx'), 'utf8')

describe('Wildloop native menu screen', () => {
  beforeAll(compileNativeBundle, 30000)

  it('renders through the portable keyed boundary', () => {
    expect(SOURCE).toContain('<View :for="group in groups()" :key="group.title"')
    expect(SOURCE).not.toContain('<FlatList')
  })

  it('lists every destination, with nothing held back for a guest', async () => {
    const screen = await start('Menu')
    const keychain = answerKeychain(screen)
    await waitForText(screen, 'Your profile')
    keychain()

    const text = shownText(screen).join(' | ')
    for (const offered of ['Your profile', 'Achievements', 'Stats', 'Notifications', 'Territory', 'Conquests', 'Challenges', 'Plans', 'Trails', 'Leaderboard', 'Battles', 'Records', 'Find athletes', 'Clubs', 'Events', 'Settings'])
      expect(text).toContain(offered)
    expect(text).not.toContain('Sign in')
  })

  /*
   * From `onAppear`, not from mount: the shell prepares this tab hidden beside
   * the Feed at launch, and a guard that ran at mount would push Login over
   * the Feed.
   *
   * Two things stop that and this sees only their sum — nothing navigates
   * until the tab is shown. Removing either one on its own still passes here,
   * so the `isFocused` half is pinned by the Record screen's own test, where
   * the guard is also called from a loader that does not wait for `onAppear`.
   */
  it('waits until the tab is shown before sending a viewer without an account to Login', async () => {
    const screen = await start('Menu', {}, ['fetch', 'secureStorage', 'haptics', 'lifecycle', 'dialog'], { __stxNativeFocused: false })
    const keychain = answerKeychain(screen, null)
    for (let attempt = 0; attempt < 40; attempt++)
      await Bun.sleep(1)
    expect(screen.sent.some((message: any) => message.type === 'NAVIGATE_OPEN')).toBe(false)

    screen.receive({ type: 'SCREEN_FOCUS', payload: { focused: true } })
    for (let attempt = 0; attempt < 60 && !screen.sent.some((message: any) => message.type === 'NAVIGATE_OPEN'); attempt++)
      await Bun.sleep(1)
    keychain()
    expect(screen.sent.some((message: any) => message.type === 'NAVIGATE_OPEN' && message.payload.path === '/login?next=%2Fmenu')).toBe(true)
  })
})

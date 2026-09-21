import { describe, expect, it } from 'bun:test'

const root = new URL('../../', import.meta.url)

describe('native session controls', () => {
  it('clears the shared account state after signing out', async () => {
    const source = await Bun.file(new URL('resources/assets/scripts/auth.ts', root)).text()

    const signOut = source.slice(source.indexOf('export async function signOut'))
    expect(signOut).toContain('secureStorage.delete(TOKEN_KEY)')
    expect(signOut).toContain('announceAuthReady(null)')
  })

  it('reaches settings and signing out from the profile, and refreshes its header state', async () => {
    const [profile, settings, header] = await Promise.all([
      Bun.file(new URL('resources/views/profile.stx', root)).text(),
      Bun.file(new URL('resources/views/settings.stx', root)).text(),
      Bun.file(new URL('resources/components/mobile-header.stx', root)).text(),
    ])

    // The app hides the site header, so the profile carries the way into
    // settings, and settings carries sign-out, deletion and the legal pages.
    expect(profile).toContain('<StxLink to="/settings" aria-label="Settings"')
    expect(settings).toContain('@click="handleSignOut()"')
    expect(settings).toContain('Log out')
    expect(settings).toContain('<StxLink to="/privacy"')
    expect(settings).toContain('<StxLink to="/terms"')
    // The header reads the session and the unread count from the shared store,
    // which the layout updates on every auth-ready, so it refreshes without a
    // listener of its own, and without bundling its own copy of the auth
    // client (stacksjs/stx#1957).
    expect(header).toContain("const wl = useStore('wl')")
    expect(header).toContain('wl.unreadCount()')
    expect(header).not.toContain('assets/scripts/auth')
    expect(header).not.toMatch(/from '@stacksjs\/mobile'/)
  })

  it('forgets the last account\'s follows, saved trails and alerts on sign-out', async () => {
    const stores = await Bun.file(new URL('resources/components/stores.stx', root)).text()
    const clear = stores.slice(stores.indexOf('clearAuthenticatedUser() {'), stores.indexOf('provideServices('))

    for (const field of ['following', 'savedTrailIds', 'notifications'])
      expect(clear).toContain(`this.${field} = []`)
  })

  it('keeps the auth client out of the nav and the sign-in sheet, which render on every page', async () => {
    const [nav, gate] = await Promise.all([
      Bun.file(new URL('resources/components/nav.stx', root)).text(),
      Bun.file(new URL('resources/components/AuthGate.stx', root)).text(),
    ])

    for (const source of [nav, gate]) {
      expect(source).not.toContain('assets/scripts/auth')
      expect(source).not.toContain('assets/scripts/game-api')
      expect(source).not.toContain('composables/useAuthGate')
    }
    expect(nav).toContain('await wl?.signOut()')
    expect(gate).toContain('await wl.signIn(emailValue, passwordValue)')
  })
})

import { describe, expect, it } from 'bun:test'

const root = new URL('../../', import.meta.url)

describe('native session controls', () => {
  it('clears the shared account state after signing out', async () => {
    const source = await Bun.file(new URL('resources/assets/scripts/auth.ts', root)).text()

    const signOut = source.slice(source.indexOf('export async function signOut'))
    expect(signOut).toContain('secureStorage.delete(TOKEN_KEY)')
    expect(signOut).toContain('announceAuthReady(null)')
  })

  it('provides a signed-in mobile logout action and refreshes its header state', async () => {
    const [profile, header] = await Promise.all([
      Bun.file(new URL('resources/views/profile.stx', root)).text(),
      Bun.file(new URL('resources/components/mobile-header.stx', root)).text(),
    ])

    expect(profile).toContain('@click="handleSignOut()"')
    expect(profile).toContain('Log out')
    expect(header).toContain("globalThis.addEventListener('wildloop:auth-ready', applyAccount)")
    expect(header).toContain("globalThis.removeEventListener('wildloop:auth-ready', applyAccount)")
  })
})

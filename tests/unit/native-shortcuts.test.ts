import { afterEach, describe, expect, it } from 'bun:test'
import {
  clearAppShortcuts,
  donateSiriPhrases,
  onAppShortcut,
  registerAppShortcuts,
  shortcutRoute,
} from '../../resources/composables/useNativeShortcuts'

/** Stand in for the object Craft injects into the webview. */
function installCraft(bridge: Record<string, unknown> | null): void {
  const host = globalThis as any
  if (bridge === null)
    delete host.craft
  else
    host.craft = { platform: 'ios', ...bridge }
}

afterEach(() => {
  installCraft(null)
})

describe('reading a tapped shortcut', () => {
  it('takes the shortcut’s own id', () => {
    expect(shortcutRoute('view-stats')).toBe('/stats')
    expect(shortcutRoute({ type: 'favorites' })).toBe('/profile?tab=saved')
  })

  it('takes the link the item carried, whichever key it arrived under', () => {
    expect(shortcutRoute({ userInfo: { url: 'wildloop://trails?near=me' } })).toBe('/trails?near=me')
    expect(shortcutRoute({ url: 'wildloop://stats' })).toBe('/stats')
    expect(shortcutRoute('https://wildloop.org/trails?near=me')).toBe('/trails?near=me')
  })

  it('prefers the id, which cannot be spoofed by a link', () => {
    expect(shortcutRoute({ type: 'view-stats', userInfo: { url: 'wildloop://record' } })).toBe('/stats')
  })

  it('navigates nowhere on anything it does not recognise', () => {
    expect(shortcutRoute({ type: 'made-up' })).toBeNull()
    expect(shortcutRoute({ url: 'https://example.com/pwned' })).toBeNull()
    expect(shortcutRoute('not a url')).toBeNull()
    expect(shortcutRoute(null)).toBeNull()
    expect(shortcutRoute(42)).toBeNull()
  })
})

describe('registering with the host', () => {
  it('is a no-op off a native host', async () => {
    installCraft(null)
    expect(await registerAppShortcuts()).toBe('unsupported')
    expect(await clearAppShortcuts()).toBe(false)
    expect(await donateSiriPhrases()).toBe(0)
  })

  it('is a no-op on a native host whose build has no shortcuts bridge', async () => {
    installCraft({})
    expect(await registerAppShortcuts()).toBe('unsupported')
  })

  it('offers every shortcut, with the link that opens it', async () => {
    let sent: any[] = []
    installCraft({ shortcuts: { set: async (items: any[]) => { sent = items; return { count: items.length } } } })

    expect(await registerAppShortcuts()).toBe('registered')
    expect(sent.map(item => item.type)).toEqual(['favorites', 'trails-near-me', 'view-stats'])
    expect(sent[1].userInfo.url).toBe('wildloop://trails?near=me')
    expect(sent[1].iconName).toBe('map.fill')
  })

  it('reports a host that refused rather than pretending it worked', async () => {
    installCraft({ shortcuts: { set: async () => { throw new Error('nope') } } })
    expect(await registerAppShortcuts()).toBe('failed')
  })

  it('does not hang a mount on a bridge call nothing answers', async () => {
    // Craft's wrappers park an unanswered callback forever; this is the guard.
    installCraft({ shortcuts: { set: () => new Promise(() => {}) } })

    const started = Date.now()
    expect(await registerAppShortcuts()).toBe('failed')
    expect(Date.now() - started).toBeLessThan(5000)
  }, 10_000)

  it('donates one phrase per shortcut and counts what was accepted', async () => {
    const donated: Array<[string, string]> = []
    installCraft({
      siri: {
        register: async (phrase: string, action: string) => {
          donated.push([phrase, action])
          if (action === 'view-stats')
            throw new Error('Siri is off')
          return true
        },
      },
    })

    expect(await donateSiriPhrases()).toBe(2)
    expect(donated.map(([, action]) => action)).toEqual(['favorites', 'trails-near-me', 'view-stats'])
    expect(donated[0][0]).toContain('Wildloop')
  })
})

describe('following a tap', () => {
  it('routes the event the host dispatches, and stops when taken down', () => {
    installCraft({ shortcuts: {} })
    const routes: string[] = []
    const stop = onAppShortcut(route => routes.push(route))

    globalThis.dispatchEvent(new CustomEvent('craftShortcut', { detail: { type: 'favorites' } }))
    globalThis.dispatchEvent(new CustomEvent('craftShortcut', { detail: { type: 'nonsense' } }))
    stop()
    globalThis.dispatchEvent(new CustomEvent('craftShortcut', { detail: { type: 'view-stats' } }))

    expect(routes).toEqual(['/profile?tab=saved'])
  })
})

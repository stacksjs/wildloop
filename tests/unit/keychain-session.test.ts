import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'

const local = new Map<string, string>()
const tab = new Map<string, string>()
const keychain = new Map<string, string>()
let keychainAccepts = true

function storage(map: Map<string, string>) {
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  }
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
}

/** A new page in a relaunched app: fresh module state, empty sessionStorage. */
async function relaunch() {
  delete (globalThis as any).__wildloopSession
  tab.clear()
  return await import(`../../resources/assets/scripts/auth.ts?page=${Math.random()}`)
}

beforeEach(() => {
  local.clear()
  tab.clear()
  keychain.clear()
  keychainAccepts = true
  const host = globalThis as any
  host.localStorage = storage(local)
  host.sessionStorage = storage(tab)
  host.window = globalThis
  host.craft = {
    platform: 'ios',
    capabilities: {},
    secureStorage: {
      // Like Craft: a write the Keychain refuses still resolves.
      set: async (key: string, value: string) => {
        if (keychainAccepts)
          keychain.set(key, value)
      },
      get: async (key: string) => keychain.get(key) ?? null,
      delete: async (key: string) => {
        keychain.delete(key)
      },
    },
  }
  host.fetch = mock(async (url: any) => json(String(url) === '/api/login'
    ? { token: 'fresh', user: { id: 5, email: 'mark@wildloop.test' } }
    : { user: { id: 5, email: 'mark@wildloop.test' } }))
})

afterEach(() => {
  const host = globalThis as any
  for (const key of ['localStorage', 'sessionStorage', 'window', 'craft', '__wildloopSession'])
    delete host[key]
})

describe('the app session on iOS', () => {
  it('survives a relaunch when the Keychain refuses the token', async () => {
    keychainAccepts = false
    const page = await relaunch()

    expect((await page.signIn('mark@wildloop.test', 'test-only')).ok).toBe(true)
    expect(local.get('auth_token')).toBe('fresh')

    const next = await relaunch()
    expect(await next.readyToken()).toBe('fresh')
  })

  it('lives in the Keychain, not app storage, when the Keychain takes it', async () => {
    const page = await relaunch()

    await page.signIn('mark@wildloop.test', 'test-only')

    expect(keychain.get('auth_token')).toBe('fresh')
    expect(local.has('auth_token')).toBe(false)
    expect(await (await relaunch()).readyToken()).toBe('fresh')
  })

  it('moves a token kept in app storage into the Keychain once it takes writes', async () => {
    local.set('auth_token', 'fresh')
    keychain.set('auth_token', 'older')
    const page = await relaunch()

    expect(await page.readyToken()).toBe('fresh')
    expect(keychain.get('auth_token')).toBe('fresh')
    expect(local.has('auth_token')).toBe(false)
  })

  it('does not show a cached account that has no token', async () => {
    local.set('auth_user', JSON.stringify({ id: 5, email: 'mark@wildloop.test' }))
    const page = await relaunch()

    await page.initializeAuthSession()

    expect(page.currentUser()).toBeNull()
  })
})

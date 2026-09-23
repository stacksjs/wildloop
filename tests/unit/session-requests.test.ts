import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { apiFetch, changePassword } from '../../resources/assets/scripts/auth'
import { createActivity, fetchAchievements, fetchFollows, persistRunAndProcess, queuedRunMessage } from '../../resources/assets/scripts/game-api'
import { nextAttemptCount, uploadNeedsAttention } from '../../resources/assets/scripts/run-upload-queue'

const store = new Map<string, string>()
const calls: Array<{ url: string, init: any }> = []

/** Answer every request with one status and capture what was sent. */
function respondWith(status: number, body: unknown = {}): void {
  calls.length = 0
  globalThis.fetch = mock(async (url: any, init: any) => {
    calls.push({ url: String(url), init })
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as any
}

beforeEach(() => {
  store.clear()
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
})

afterEach(() => {
  delete (globalThis as any).localStorage
})

describe('API requests', () => {
  it('send the bearer token', async () => {
    store.set('auth_token', 'abc')
    respondWith(200, {})

    await apiFetch('/api/notifications')

    expect(calls.at(-1)?.init.headers.Authorization).toBe('Bearer abc')
  })

  it('end the session on this device when the API refuses the token', async () => {
    store.set('auth_token', 'abc')
    store.set('auth_user', JSON.stringify({ id: 5, email: 'pawel@wildloop.test' }))
    respondWith(401, { error: 'Unauthenticated' })

    const response = await apiFetch('/api/notifications')

    expect(response.status).toBe(401)
    expect(store.has('auth_token')).toBe(false)
    expect(store.has('auth_user')).toBe(false)
  })

  it('leave the session alone on any other failure', async () => {
    store.set('auth_token', 'abc')
    respondWith(403, { error: 'Forbidden' })

    await apiFetch('/api/clubs/1')

    expect(store.get('auth_token')).toBe('abc')
  })
})

describe('recorded runs', () => {
  const run = {
    user_id: 5,
    activity_type: 'Trail Run',
    distance: 3.1,
    duration: '0:31:00',
    upload_id: 'run:session-test',
    recording_source: 'native_gps',
    game_mode: 'capture',
  } as const

  it('does not promise an offline save after session expiry when device storage is unavailable', async () => {
    store.set('auth_token', 'abc')
    respondWith(401, { error: 'Unauthenticated' })

    // Bun has no IndexedDB. Durable retention is exercised separately in
    // tests/browser/recording-storage.ts using the real browser database.
    await expect(persistRunAndProcess({ ...run })).rejects.toThrow('storage')
  })

  it('does not promise an offline save after validation failure when device storage is unavailable', async () => {
    store.set('auth_token', 'abc')
    respondWith(422, { success: false, error: 'Validation failed' })

    await expect(persistRunAndProcess({ ...run })).rejects.toThrow('storage')
  })

  it('do not spend an upload attempt on an ended session', () => {
    expect(nextAttemptCount(2, Object.assign(new Error('Unauthenticated'), { status: 401 }))).toBe(2)
    expect(nextAttemptCount(2, Object.assign(new Error('Server error'), { status: 500 }))).toBe(3)
    expect(nextAttemptCount(0, new TypeError('Failed to fetch'))).toBe(1)
  })

  it('tell the athlete why their run is waiting', () => {
    expect(queuedRunMessage(new TypeError('Failed to fetch'))).toBe('Saved on this device and will sync when Wildloop is online')
    expect(queuedRunMessage(Object.assign(new Error('Unauthenticated'), { status: 401 }))).toContain('Sign in again')
  })

  it('parks permanent refusals but keeps session, timeout and rate-limit failures retryable', () => {
    for (const status of [400, 403, 404, 409, 413, 422])
      expect(uploadNeedsAttention({ status })).toBe(true)
    for (const status of [401, 408, 429, 500, 503])
      expect(uploadNeedsAttention({ status })).toBe(false)
    expect(uploadNeedsAttention(new TypeError('Failed to fetch'))).toBe(false)
    expect(queuedRunMessage(Object.assign(new Error('Track needs review'), { status: 422 }))).toContain('Automatic retries stopped')
  })

  it('shows validation field reasons instead of a generic rejection', async () => {
    store.set('auth_token', 'abc')
    for (const body of [
      { error: 'Validation failed', fields: { gpx_data: 'Track needs review' } },
      { error: 'Validation failed', errors: { gpx_data: ['Track needs review'] } },
    ]) {
      respondWith(422, body)
      await expect(createActivity({ ...run })).rejects.toThrow('Track needs review')
    }
    globalThis.fetch = mock(async () => new Response('Not JSON', { status: 413 })) as any
    await expect(createActivity({ ...run })).rejects.toThrow('That request could not be completed')
  })
})

describe('a page with several copies of the auth module', () => {
  // stx inlines auth.ts into every bundle that imports it: five copies on the
  // profile page. Two copies stand in for them here.
  async function twoCopies() {
    delete (globalThis as any).__wildloopSession
    const nav = await import(`../../resources/assets/scripts/auth.ts?bundle=nav-${Math.random()}`)
    const layout = await import(`../../resources/assets/scripts/auth.ts?bundle=layout-${Math.random()}`)
    return { nav, layout }
  }

  it('restores the session once', async () => {
    store.set('auth_token', 'abc')
    respondWith(200, { user: { id: 5, email: 'pawel@wildloop.test' } })
    const { nav, layout } = await twoCopies()

    await Promise.all([nav.initializeAuthSession(), layout.initializeAuthSession()])

    expect(calls.filter(call => call.url === '/api/me')).toHaveLength(1)
  })

  it('runs a sign-out hook registered by any copy', async () => {
    store.set('auth_token', 'abc')
    respondWith(200, {})
    const { nav, layout } = await twoCopies()
    let pushUnregistered = false
    layout.beforeSignOut(async () => {
      pushUnregistered = true
    })

    await nav.signOut()

    expect(pushUnregistered).toBe(true)
  })

  it('sends identical GETs asked for together once, and gives each caller its own copy', async () => {
    store.set('auth_token', 'abc')
    respondWith(200, { success: true, followingIds: [7] })
    const { nav, layout } = await twoCopies()

    const [first, second] = await Promise.all([
      nav.apiFetch('/api/users/5/follows'),
      layout.apiFetch('/api/users/5/follows'),
    ])

    expect(calls.filter(call => call.url === '/api/users/5/follows')).toHaveLength(1)
    expect(await first.json()).toEqual({ success: true, followingIds: [7] })
    expect(await second.json()).toEqual({ success: true, followingIds: [7] })
  })
})

describe('per-athlete reads', () => {
  it('never ask for the guest sentinel, user 0', async () => {
    store.set('auth_token', 'abc')
    respondWith(200, { success: true })

    expect(await fetchFollows(0)).toBeNull()
    expect(await fetchAchievements(0)).toBeNull()
    expect(calls.some(call => call.url.includes('/users/0/'))).toBe(false)
  })
})

describe('changing the password', () => {
  it('keeps this device signed in with the new token the server hands back', async () => {
    store.set('auth_token', 'old-token')
    respondWith(200, { success: true, message: 'Password changed. Other devices have been signed out.', token: 'new-token' })

    const result = await changePassword({ currentPassword: 'old pass', password: 'new password 1', confirmation: 'new password 1', deviceId: 'dev-A' })

    const request = calls.find(call => call.url === '/api/me/password')
    expect(request?.init.method).toBe('PUT')
    expect(JSON.parse(request?.init.body).device_id).toBe('dev-A')
    expect(result).toEqual({ ok: true, message: 'Password changed. Other devices have been signed out.' })
    expect(store.get('auth_token')).toBe('new-token')
  })

  it('leaves the session alone when the current password is wrong', async () => {
    store.set('auth_token', 'abc')
    respondWith(403, { success: false, error: 'That is not your current password.' })

    const result = await changePassword({ currentPassword: 'nope', password: 'new password 1', confirmation: 'new password 1' })

    expect(result).toEqual({ ok: false, message: 'That is not your current password.' })
    expect(store.get('auth_token')).toBe('abc')
  })
})

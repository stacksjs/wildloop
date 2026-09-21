import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { apiFetch } from '../../resources/assets/scripts/auth'
import { persistRunAndProcess, queuedRunMessage } from '../../resources/assets/scripts/game-api'
import { nextAttemptCount } from '../../resources/assets/scripts/run-upload-queue'

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
    upload_id: 'run:session-test',
    recording_source: 'native_gps',
    game_mode: 'capture',
  } as const

  it('are kept when the upload is refused because the session ended', async () => {
    store.set('auth_token', 'abc')
    respondWith(401, { error: 'Unauthenticated' })

    const result = await persistRunAndProcess({ ...run })

    expect(result).toMatchObject({ activityId: null, queued: true })
    expect(result.error).toBe('Saved on this device. Sign in again and it will upload.')
  })

  it('are kept when the API rejects them as invalid', async () => {
    store.set('auth_token', 'abc')
    respondWith(422, { success: false, error: 'Validation failed' })

    const result = await persistRunAndProcess({ ...run })

    expect(result.queued).toBe(true)
    expect(result.error).toContain('Validation failed')
  })

  it('do not spend an upload attempt on an ended session', () => {
    expect(nextAttemptCount(2, Object.assign(new Error('Unauthenticated'), { status: 401 }))).toBe(2)
    expect(nextAttemptCount(2, Object.assign(new Error('Server error'), { status: 500 }))).toBe(3)
    expect(nextAttemptCount(0, new TypeError('Failed to fetch'))).toBe(1)
  })

  it('tell the athlete why their run is waiting', () => {
    expect(queuedRunMessage(new TypeError('Failed to fetch'))).toBe('Saved on this device and will sync when WildLoop is online')
    expect(queuedRunMessage(Object.assign(new Error('Unauthenticated'), { status: 401 }))).toContain('Sign in again')
  })
})

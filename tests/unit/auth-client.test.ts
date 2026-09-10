import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { refreshCurrentUser, signIn, signOut } from '../../resources/assets/scripts/auth'

/**
 * The sign-in page called a bare `auth` global that nothing defined, so
 * pressing Sign In threw a ReferenceError and the form rendered
 * `auth is not defined` where the error message goes. Nobody could sign in.
 *
 * These pin the replacement: every outcome comes back as a result the page can
 * render, and a defect in our own code never becomes the sentence a visitor
 * reads.
 */

const store = new Map<string, string>()

beforeEach(() => {
  store.clear()

  // Minimal browser surface: the module reads the CSRF cookie and writes the
  // session to localStorage.
  ;(globalThis as any).document = { cookie: 'X-CSRF-Token=tok-123' }
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  }
})

afterEach(() => {
  delete (globalThis as any).document
  delete (globalThis as any).localStorage
})

/** Stub `fetch` with a fixed outcome and capture what was sent. */
function stubFetch(outcome: { status?: number, body?: unknown } | Error): { calls: any[] } {
  const calls: any[] = []
  globalThis.fetch = mock(async (url: any, init: any) => {
    calls.push({ url, init })
    if (outcome instanceof Error)
      throw outcome
    return new Response(JSON.stringify(outcome.body ?? {}), {
      status: outcome.status ?? 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as any
  return { calls }
}

describe('signIn', () => {
  it('stores the session and reports success', async () => {
    stubFetch({ body: { token: 'abc123', user: { id: 1, email: 'chris@wildloop.org', name: 'Chris' } } })

    const result = await signIn('chris@wildloop.org', 'correct-horse')

    expect(result.ok).toBe(true)
    expect(result.user?.email).toBe('chris@wildloop.org')
    // game-api.ts reads this same key, so activity writes authenticate too.
    expect(store.get('auth_token')).toBe('abc123')
  })

  it('echoes the CSRF cookie, which the server requires on unsafe methods', async () => {
    const { calls } = stubFetch({ body: { token: 't' } })

    await signIn('a@b.c', 'password123')

    expect(calls[0].init.headers['X-CSRF-Token']).toBe('tok-123')
    expect(calls[0].init.credentials).toBe('same-origin')
  })

  it('shows the API sentence on bad credentials', async () => {
    stubFetch({ status: 401, body: { success: false, message: 'Incorrect email or password' } })

    const result = await signIn('chris@wildloop.org', 'wrong-password')

    expect(result.ok).toBe(false)
    expect(result.failure?.message).toBe('Incorrect email or password')
    expect(store.has('auth_token')).toBe(false)
  })

  it('surfaces the field message on a validation failure', async () => {
    stubFetch({
      status: 422,
      body: { error: 'Validation failed', errors: { password: ['Password must be between 6 and 255 characters.'] } },
    })

    const result = await signIn('chris@wildloop.org', 'abc')

    expect(result.failure?.message).toBe('Password must be between 6 and 255 characters.')
    expect(result.failure?.fields?.password).toBeDefined()
  })

  it('explains a stale CSRF cookie as the reload it needs', async () => {
    stubFetch({ status: 403, body: { error: 'Forbidden', message: 'CSRF token mismatch' } })

    const result = await signIn('chris@wildloop.org', 'password123')

    expect(result.failure?.message.toLowerCase()).toContain('refresh')
  })

  it('says the server is unreachable rather than throwing', async () => {
    stubFetch(new TypeError('Failed to fetch'))

    const result = await signIn('chris@wildloop.org', 'password123')

    expect(result.ok).toBe(false)
    expect(result.failure?.message.toLowerCase()).toContain('connection')
  })

  it('never renders a defect in our own code to the user', async () => {
    // The exact shape of the original bug.
    stubFetch(new ReferenceError('auth is not defined'))

    const result = await signIn('chris@wildloop.org', 'password123')

    expect(result.failure?.message).not.toContain('not defined')
    expect(result.failure?.unexpected).toBe(true)
  })

  it('does not treat a 200 without a token as a session', async () => {
    stubFetch({ body: { user: { id: 1, email: 'a@b.c' } } })

    const result = await signIn('a@b.c', 'password123')

    expect(result.ok).toBe(false)
    expect(store.has('auth_token')).toBe(false)
  })

  it('copes with a response that is not JSON at all', async () => {
    // A proxy's HTML error page must not throw a SyntaxError at the person
    // waiting on the form.
    globalThis.fetch = mock(async () => new Response('<html>502</html>', { status: 502 })) as any

    const result = await signIn('a@b.c', 'password123')

    expect(result.ok).toBe(false)
    expect(result.failure?.message.length).toBeGreaterThan(0)
  })
})

describe('signOut', () => {
  it('clears the session', async () => {
    stubFetch({ body: { token: 'abc', user: { id: 1, email: 'a@b.c' } } })
    await signIn('a@b.c', 'password123')

    signOut()

    expect(store.has('auth_token')).toBe(false)
    expect(store.has('auth_user')).toBe(false)
  })
})

describe('restored sessions', () => {
  it('hydrates the cached user from the restored bearer token', async () => {
    store.set('auth_token', 'restored-token')
    const { calls } = stubFetch({
      body: { user: { id: 7, email: 'alex@wildloop.org', name: 'Alex', roles: ['admin'] } },
    })

    const user = await refreshCurrentUser()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/me')
    expect(calls[0].init.headers.Authorization).toBe('Bearer restored-token')
    expect(JSON.parse(store.get('auth_user') ?? '{}')).toMatchObject({
      id: 7,
      name: 'Alex',
      roles: ['admin'],
    })
    expect(user).toMatchObject({ id: 7, name: 'Alex' })
  })

  it('accepts the framework default bare-user response', async () => {
    store.set('auth_token', 'restored-token')
    stubFetch({ body: { id: 8, email: 'sam@wildloop.org', name: 'Sam' } })

    const user = await refreshCurrentUser()

    expect(user).toMatchObject({ id: 8, name: 'Sam' })
    expect(JSON.parse(store.get('auth_user') ?? '{}')).toMatchObject({ id: 8, name: 'Sam' })
  })
})

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { readyToken, refreshCurrentUser, requestPasswordReset, signIn, signOut, signUp, token } from '../../resources/assets/scripts/auth'

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
const perSession = new Map<string, string>()

function webStorage(map: Map<string, string>) {
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

/**
 * Start the page over, as a reload or a fresh tab does.
 *
 * Also what keeps this file to itself: the session lives on `globalThis`, so
 * a token left in memory here was still the bearer every later test file saw.
 */
function reopenPage(): void {
  const page = (globalThis as any).__wildloopSession
  page.token = null
  page.initialization = null
  page.inflight.clear()
}

beforeEach(() => {
  store.clear()
  perSession.clear()
  reopenPage()

  // Minimal browser surface: the module reads the CSRF cookie and writes the
  // session to local storage, or to session storage when it is not meant to
  // outlive the browser.
  ;(globalThis as any).document = { cookie: 'X-CSRF-Token=tok-123' }
  ;(globalThis as any).localStorage = webStorage(store)
  ;(globalThis as any).sessionStorage = webStorage(perSession)
})

afterEach(() => {
  reopenPage()
  delete (globalThis as any).document
  delete (globalThis as any).localStorage
  delete (globalThis as any).sessionStorage
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

describe('requestPasswordReset', () => {
  it('accepts a neutral success without creating a session', async () => {
    const { calls } = stubFetch({ body: { success: true } })
    expect((await requestPasswordReset(' person@example.com ')).ok).toBe(true)
    expect(calls[0].url).toBe('/api/password/forgot')
    expect(JSON.parse(calls[0].init.body)).toEqual({ email: 'person@example.com' })
    expect(calls[0].init.headers['X-CSRF-Token']).toBe('tok-123')
    expect(store.has('auth_token')).toBe(false)
  })

  it.each([403, 422, 500, 503])('does not confirm an inbox on HTTP %i', async (status) => {
    stubFetch({ status })
    const result = await requestPasswordReset('person@example.com')
    expect(result.ok).toBe(false)
    expect(result.message.length).toBeGreaterThan(0)
  })

  it('shows email validation feedback', async () => {
    stubFetch({ status: 422, body: { errors: { email: ['Enter a valid email address.'] } } })
    expect((await requestPasswordReset('invalid')).message).toBe('Enter a valid email address.')
  })

  it('explains rate limiting', async () => {
    stubFetch({ status: 429 })
    expect(await requestPasswordReset('person@example.com')).toEqual({
      ok: false,
      message: 'Too many reset attempts. Please try again in a few minutes.',
    })
  })

  it('handles a non-JSON proxy failure', async () => {
    globalThis.fetch = mock(async () => new Response('<html>Bad gateway</html>', { status: 502 })) as any
    const result = await requestPasswordReset('person@example.com')
    expect(result.ok).toBe(false)
    expect(result.message).not.toContain('JSON')
  })

  it('explains a network failure', async () => {
    stubFetch(new TypeError('Failed to fetch'))
    const result = await requestPasswordReset('person@example.com')
    expect(result.ok).toBe(false)
    expect(result.message).toContain('connection')
  })
})

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

describe('signUp', () => {
  it('explains an existing account without replacing the current session', async () => {
    store.set('auth_token', 'existing-session')
    const message = 'An account with this email already exists. Log in or reset your password.'
    stubFetch({ status: 409, body: { success: false, error: message, errors: { email: [message] } } })

    const result = await signUp({ name: 'Test User', email: 'existing@example.com', password: 'valid-password' })

    expect(result.ok).toBe(false)
    expect(result.failure?.message).toBe(message)
    expect(result.failure?.fields?.email).toBe(message)
    expect(store.get('auth_token')).toBe('existing-session')
  })
})

describe('signOut', () => {
  it('revokes the token on the server, then clears the session', async () => {
    const { calls } = stubFetch({ body: { token: 'abc', user: { id: 1, email: 'a@b.c' } } })
    await signIn('a@b.c', 'password123')

    await signOut()

    const logout = calls.find(call => call.url === '/api/logout')
    expect(logout?.init.method).toBe('POST')
    expect(logout?.init.headers.Authorization).toBe('Bearer abc')
    expect(store.has('auth_token')).toBe(false)
    expect(store.has('auth_user')).toBe(false)
  })

  it('still signs out on this device when the server cannot be reached', async () => {
    stubFetch({ body: { token: 'abc', user: { id: 1, email: 'a@b.c' } } })
    await signIn('a@b.c', 'password123')
    stubFetch(new Error('offline'))

    await signOut()

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

/**
 * "Remember me" on the sign-in form. The box was on the page and the form
 * sent nothing, so every sign-in lasted thirty days — on a borrowed laptop as
 * much as on your own. The choice now decides both how long the API's token
 * lasts and whether this browser keeps the session after it closes.
 */
describe('remember me', () => {
  const SESSION_KEY = 'wildloop_auth_token'

  it('tells the API which kind of session was asked for', async () => {
    const { calls } = stubFetch({ body: { token: 'abc', user: { id: 1, email: 'a@b.c' } } })

    await signIn('a@b.c', 'password123', true)
    expect(JSON.parse(calls[0].init.body).remember).toBe(true)

    await signIn('a@b.c', 'password123', false)
    expect(JSON.parse(calls[1].init.body).remember).toBe(false)
  })

  it('keeps a remembered session where it outlives the browser', async () => {
    stubFetch({ body: { token: 'remembered', user: { id: 1, email: 'a@b.c' } } })

    await signIn('a@b.c', 'password123', true)

    expect(store.get('auth_token')).toBe('remembered')
    expect(perSession.has(SESSION_KEY)).toBe(false)
  })

  it('keeps an ordinary session to this browser session', async () => {
    stubFetch({ body: { token: 'this-visit', user: { id: 1, email: 'a@b.c' } } })

    await signIn('a@b.c', 'password123', false)

    expect(perSession.get(SESSION_KEY)).toBe('this-visit')
    expect(store.has('auth_token')).toBe(false)
  })

  it('does not leave the old copy behind when the choice changes', async () => {
    stubFetch({ body: { token: 'this-visit', user: { id: 1, email: 'a@b.c' } } })
    await signIn('a@b.c', 'password123', true)
    await signIn('a@b.c', 'password123', false)
    expect(store.has('auth_token')).toBe(false)

    stubFetch({ body: { token: 'kept', user: { id: 1, email: 'a@b.c' } } })
    await signIn('a@b.c', 'password123', true)
    expect(perSession.has(SESSION_KEY)).toBe(false)
    expect(store.get('auth_token')).toBe('kept')
  })

  it('signs the in-app gate in as remembered, which is what it did before', async () => {
    const { calls } = stubFetch({ body: { token: 'gate', user: { id: 1, email: 'a@b.c' } } })

    await signIn('a@b.c', 'password123')

    expect(JSON.parse(calls[0].init.body).remember).toBe(true)
    expect(store.get('auth_token')).toBe('gate')
  })

  it('survives a reload, and goes when the browser does', async () => {
    stubFetch({ body: { token: 'this-visit', user: { id: 1, email: 'a@b.c' } } })
    await signIn('a@b.c', 'password123', false)

    // A reload: the page starts over, session storage does not.
    reopenPage()
    stubFetch({ body: { user: { id: 1, email: 'a@b.c' } } })
    expect(await readyToken()).toBe('this-visit')

    // A new browser: session storage is empty.
    reopenPage()
    perSession.clear()
    expect(await readyToken()).toBeNull()
  })

  it('ends the session on this device once the token has expired', async () => {
    stubFetch({ body: { token: 'this-visit', user: { id: 1, email: 'a@b.c' } } })
    await signIn('a@b.c', 'password123', false)

    // The server answers the next page load with 401: the short token is up.
    reopenPage()
    stubFetch({ status: 401, body: { error: 'Unauthorized' } })
    expect(await readyToken()).toBeNull()
    expect(token()).toBeNull()
    expect(perSession.has(SESSION_KEY)).toBe(false)
    expect(store.has('auth_user')).toBe(false)
  })

  it('leaves a this-visit session where it is when the password changes', async () => {
    stubFetch({ body: { token: 'this-visit', user: { id: 1, email: 'a@b.c' } } })
    await signIn('a@b.c', 'password123', false)

    // A password change reissues the token; it must not quietly promote an
    // ordinary session into a remembered one.
    stubFetch({ body: { token: 'reissued', message: 'Password changed.' } })
    const { changePassword } = await import('../../resources/assets/scripts/auth')
    expect((await changePassword({ currentPassword: 'password123', password: 'another-one', confirmation: 'another-one' })).ok).toBe(true)
    expect(perSession.get(SESSION_KEY)).toBe('reissued')
    expect(store.has('auth_token')).toBe(false)
  })
})

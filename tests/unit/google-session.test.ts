import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { HANDOFF_COOKIE, handoffCookieHeader } from '../../app/Support/socialRequest'

/**
 * The last step of signing in with Google: the page trades the hand-off cookie
 * for the session the callback opened.
 *
 * Small, and the only place a bearer token is deliberately put in a response
 * body. Everything here is about that: the cookie works once, the token is
 * never handed over unless it still opens a session, the body carries only the
 * fields it means to, and none of it is cacheable.
 */

/*
 * `Action` is an auto-imported global in the app, injected by the server at
 * boot and absent under `bun test`. Here it only has to hand back the spec so
 * `handle` can be called directly.
 */
;(globalThis as any).Action = class {
  constructor(spec: any) {
    return spec
  }
}

/*
 * Only `Auth` is replaced, and by spreading the real module: `mock.module`
 * applies to the whole test process, so swapping a module wholesale strips the
 * exports other suites import. `afterAll` puts the original back.
 *
 * `profileFields` is deliberately NOT mocked — it decides which of a user's
 * fields reach the response, which is one of the things under test.
 */
const realAuth = await import('@stacksjs/auth')

afterAll(() => {
  mock.module('@stacksjs/auth', () => realAuth)
})

/** What `Auth.getUserFromToken` should do with the token it is given. */
let resolve: (token: string) => any
/** Every token the action tried to resolve. */
let resolved: string[] = []

mock.module('@stacksjs/auth', () => ({
  ...realAuth,
  Auth: {
    ...realAuth.Auth,
    async getUserFromToken(token: string) {
      resolved.push(token)
      return resolve(token)
    },
  },
}))

const handler = async () => (await import('../../app/Actions/Auth/GoogleSessionAction')).default as any

// ── helpers ──────────────────────────────────────────────────────────────────

const TOKEN = '42|kjSaL8yzR3vQpX7bN2mF'

const ADA = {
  id: 7,
  email: 'ada@example.com',
  name: 'Ada Lovelace',
  bio: 'Counts things.',
  location: 'London',
  created_at: '2026-01-02T03:04:05.000Z',
  avatar: null,
}

/** The `Cookie` header a browser would send back, built by the real helper. */
const sentBack = (token = TOKEN) => handoffCookieHeader(HANDOFF_COOKIE, token, false).split(';')[0]

/** Drive the action once. */
async function session(options: { cookie?: string | null, body?: Record<string, string> } = {}) {
  const response: Response = await (await handler()).handle({
    headers: { get: (key: string) => (key.toLowerCase() === 'cookie' ? (options.cookie ?? null) : null) },
    get: (key: string) => options.body?.[key],
  })
  const text = await response.text()
  return {
    response,
    status: response.status,
    body: JSON.parse(text) as any,
    setCookies: response.headers.getSetCookie(),
    /** True when the hand-off cookie was expired on the way out. */
    spent: response.headers.getSetCookie().some(c => c.startsWith(`${HANDOFF_COOKIE}=;`) && c.includes('Max-Age=0')),
  }
}

beforeEach(() => {
  resolved = []
  resolve = () => ADA
})

// ── nothing to trade ─────────────────────────────────────────────────────────

describe('without a usable hand-off', () => {
  it('refuses a request carrying no cookies at all', async () => {
    const result = await session({ cookie: null })
    expect(result.status).toBe(401)
    expect(result.body.success).toBe(false)
    expect(resolved).toHaveLength(0)
  })

  it('refuses a request whose cookies do not include the hand-off', async () => {
    const result = await session({ cookie: 'wl_google_state=abc; other=1' })
    expect(result.status).toBe(401)
    expect(resolved).toHaveLength(0)
  })

  it('refuses an empty hand-off cookie rather than resolving an empty token', async () => {
    const result = await session({ cookie: `${HANDOFF_COOKIE}=` })
    expect(result.status).toBe(401)
    expect(resolved).toHaveLength(0)
  })

  /*
   * The cookie is the only way in.
   *
   * If the token were also read from the body or the query, anybody could post
   * a token of their choosing and be handed whatever session it opens — which
   * is the entire reason the callback put it in an httpOnly cookie instead of
   * the URL.
   */
  it('does not accept a token supplied any other way', async () => {
    const result = await session({ cookie: null, body: { token: TOKEN } })
    expect(result.status).toBe(401)
    expect(result.body.token).toBeUndefined()
    expect(resolved).toHaveLength(0)
  })
})

// ── a hand-off that no longer opens anything ─────────────────────────────────

describe('with a hand-off that has stopped working', () => {
  it('refuses a token that resolves to nobody', async () => {
    resolve = () => null
    const result = await session({ cookie: sentBack() })
    expect(result.status).toBe(401)
    expect(result.body.token).toBeUndefined()
  })

  it('refuses a token that resolves to something without an id', async () => {
    resolve = () => ({ email: 'ada@example.com' })
    const result = await session({ cookie: sentBack() })
    expect(result.status).toBe(401)
    expect(result.body.token).toBeUndefined()
  })

  it('refuses rather than failing when resolving the token throws', async () => {
    // A revoked session, or a database that is briefly unreachable. Either way
    // the answer is the same 401, not a 500 the page cannot act on.
    resolve = () => {
      throw new Error('session revoked')
    }
    const result = await session({ cookie: sentBack() })
    expect(result.status).toBe(401)
    expect(result.body.success).toBe(false)
  })

  it('says the same thing whether the cookie was missing or has been revoked', async () => {
    const missing = await session({ cookie: null })
    resolve = () => null
    const revoked = await session({ cookie: sentBack() })
    // Telling these apart tells somebody probing which of the two they hit.
    expect(revoked.body.error).toBe(missing.body.error)
    expect(revoked.status).toBe(missing.status)
  })
})

// ── the exchange ─────────────────────────────────────────────────────────────

describe('trading the hand-off for the session', () => {
  it('hands over the token the cookie carried', async () => {
    const result = await session({ cookie: sentBack() })
    expect(result.status).toBe(200)
    expect(result.body.success).toBe(true)
    expect(result.body.token).toBe(TOKEN)
  })

  it('resolves the token from the cookie, byte for byte', async () => {
    await session({ cookie: sentBack() })
    expect(resolved).toEqual([TOKEN])
  })

  it('carries a token that needed encoding back intact', async () => {
    // Session tokens are base64-ish: `=` padding, and `|` between the id and
    // the secret, both of which the cookie percent-encodes on the way out.
    const awkward = '7|abc.def-ghi_jkl=='
    const result = await session({ cookie: sentBack(awkward) })
    expect(resolved).toEqual([awkward])
    expect(result.body.token).toBe(awkward)
  })

  it('describes the person who signed in', async () => {
    const result = await session({ cookie: sentBack() })
    expect(result.body.user.id).toBe(7)
    expect(result.body.user.email).toBe('ada@example.com')
    expect(result.body.user.name).toBe('Ada Lovelace')
    expect(result.body.user.bio).toBe('Counts things.')
    expect(result.body.user.location).toBe('London')
    expect(result.body.user.joinedAt).toBe('2026-01-02T03:04:05.000Z')
  })

  /*
   * The field list is a whitelist, and this is what keeps it one.
   *
   * The user here is whatever the ORM returns, which is the whole row —
   * password hash included. Spreading it into the response instead of naming
   * the fields would publish that hash to anyone completing a sign-in, and
   * would look exactly like a working feature.
   */
  it('publishes only the fields it names, not the row it was given', async () => {
    resolve = () => ({
      ...ADA,
      password: '$2b$10$aVeryRealLookingBcryptHash',
      remember_token: 'secret-token',
      two_factor_secret: 'JBSWY3DPEHPK3PXP',
      stripe_id: 'cus_12345',
    })
    const result = await session({ cookie: sentBack() })

    expect(Object.keys(result.body.user).sort()).toEqual([
      'avatar',
      'bio',
      'email',
      'id',
      'joinedAt',
      'location',
      'name',
    ])
    // Named individually too, so the failure says which one leaked.
    const serialised = JSON.stringify(result.body)
    for (const secret of ['$2b$10$aVeryRealLookingBcryptHash', 'secret-token', 'JBSWY3DPEHPK3PXP', 'cus_12345'])
      expect(serialised, secret).not.toContain(secret)
  })
})

// ── once, and never cached ───────────────────────────────────────────────────

describe('on every answer', () => {
  const outcomes = async () => {
    const all = []
    all.push(await session({ cookie: null }))
    resolve = () => null
    all.push(await session({ cookie: sentBack() }))
    resolve = () => ADA
    all.push(await session({ cookie: sentBack() }))
    return all
  }

  /*
   * The cookie is spent whatever happens, which is what makes the hand-off
   * single-use. Left in place after a success it is a live bearer token sitting
   * in the browser for the rest of its minute, replayable by anything that can
   * make the browser post to this endpoint.
   */
  it('spends the hand-off cookie', async () => {
    for (const result of await outcomes())
      expect(result.spent, String(result.status)).toBe(true)
  })

  /*
   * A cached response is the worst failure this file can have: the success body
   * contains a bearer token, and a shared cache would hand it to whoever asked
   * next.
   */
  it('lets nothing cache the answer', async () => {
    for (const result of await outcomes())
      expect(result.response.headers.get('cache-control'), String(result.status)).toBe('no-store')
  })

  it('answers as JSON', async () => {
    for (const result of await outcomes())
      expect(result.response.headers.get('content-type')).toBe('application/json')
  })

  it('never puts the token anywhere but the body', async () => {
    const result = await session({ cookie: sentBack() })
    // Not in a redirect, and not written back into a cookie a script could
    // later be tricked into leaking.
    expect(result.response.headers.get('location')).toBeNull()
    expect(result.setCookies.join(';')).not.toContain(TOKEN)
  })
})

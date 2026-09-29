import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { STATE_COOKIE, stateCookieHeader } from '../../app/Support/socialRequest'

/**
 * The Google callback, driven end to end against a stubbed token endpoint.
 *
 * This is the half of signing in with Google that decides who somebody is: it
 * verifies the state, trades the code for a token, picks between signing in,
 * linking and creating, opens the session and hands it over. Every other test
 * around this feature checks a pure function; this one runs the action.
 *
 * Nothing real is contacted. `fetch` is replaced, so the "token endpoint" is a
 * value this file controls, and the database is a recorder that reports what it
 * was asked rather than storing anything.
 */

/*
 * `Action` is an auto-imported global in the app, injected by the server at
 * boot and absent under `bun test`. The real one registers the action and
 * returns something with the same shape; here it only has to hand back the
 * spec so `handle` can be called directly.
 */
;(globalThis as any).Action = class {
  constructor(spec: any) {
    return spec
  }
}

/** Every statement the action ran, in order, with its interpolated values. */
let queries: { text: string, values: unknown[] }[] = []
/** What the recorder should answer with. */
let rows: { identityUserId?: number | null, userByEmail?: { id: number, email: string } | null, createdId?: number | null }
/** Set when the session cannot be opened. */
let sessionFails = false
/** Set when writing the identity row fails, as a unique-index clash would. */
let identityWriteFails = false
/** How the session was opened: the id, and the policy it was given. */
let logins: { userId: number, options: Record<string, unknown> }[] = []
/** Every request the action made to the "token endpoint". */
let exchanges: { url: string, body: Record<string, string> }[] = []
/** What the stubbed token endpoint answers with. */
let tokenResponse: () => Promise<Response> | Response

/*
 * All test files share one process, and `mock.module` replaces a module for
 * that whole process rather than for this file. Replacing one wholesale strips
 * the exports other suites import — `defineModel` from the ORM, `hashMake`
 * from security — and breaks them with a missing-export error pointing at
 * their file instead of this one.
 *
 * So each mock spreads the real module and overrides only what it needs, and
 * `afterAll` puts the originals back.
 */
const realOrm = await import('@stacksjs/orm')
const realAuth = await import('@stacksjs/auth')
const realSecurity = await import('@stacksjs/security')
const realFetch = globalThis.fetch
const realAppUrl = process.env.APP_URL

/*
 * The credentials are reached by mutating the real config rather than by
 * mocking it: `config` is a Proxy that cannot be spread, and the action only
 * reads two string properties off it.
 */
const { config } = await import('@stacksjs/config')
const google = (config as any).auth.social.google as { clientId?: string, clientSecret?: string }
const realCredentials = { clientId: google.clientId, clientSecret: google.clientSecret }

afterAll(() => {
  mock.module('@stacksjs/orm', () => realOrm)
  mock.module('@stacksjs/auth', () => realAuth)
  mock.module('@stacksjs/security', () => realSecurity)
  Object.assign(google, realCredentials)
  globalThis.fetch = realFetch
  if (realAppUrl === undefined)
    delete process.env.APP_URL
  else process.env.APP_URL = realAppUrl
})

mock.module('@stacksjs/orm', () => ({
  ...realOrm,
  db: {
    sql(strings: TemplateStringsArray, ...values: unknown[]) {
      const text = strings.join('?').replace(/\s+/g, ' ').trim()
      queries.push({ text, values })
      return {
        async execute() {
          if (identityWriteFails && text.includes('INSERT INTO user_identities'))
            throw new Error('UNIQUE constraint failed: user_identities.provider, user_identities.provider_user_id')
          if (text.includes('FROM user_identities'))
            return rows.identityUserId == null ? [] : [{ user_id: rows.identityUserId }]
          if (text.includes('FROM users'))
            return rows.userByEmail ? [rows.userByEmail] : []
          if (text.includes('INSERT INTO users'))
            return rows.createdId == null ? [] : [{ id: rows.createdId }]
          return []
        },
      }
    },
  },
}))

mock.module('@stacksjs/auth', () => ({
  ...realAuth,
  Auth: {
    async loginUsingId(userId: number, options: Record<string, unknown>) {
      logins.push({ userId, options })
      if (sessionFails)
        throw new Error('no session')
      return { token: `token-for-${userId}` }
    },
  },
  resolveBrowserSessionPolicy: (remember: boolean) => ({ expiresInMinutes: remember ? 43_200 : 720, withRefreshToken: remember }),
}))

mock.module('@stacksjs/security', () => ({ ...realSecurity, makeHash: async (value: string) => `bcrypt(${value})` }))

/**
 * The stubbed token endpoint. Installed per test rather than at module load,
 * because the test files all share one process and a `fetch` replaced while
 * this file is merely being loaded would be in place for other suites' tests.
 */
const stubFetch = (async (url: any, init: any) => {
  exchanges.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(String(init?.body))) })
  return tokenResponse()
}) as typeof fetch

const handler = async () => (await import('../../app/Actions/Auth/GoogleCallbackAction')).default as any

// ── helpers ──────────────────────────────────────────────────────────────────

const STATE = 'a1b2c3d4'.repeat(8)

/** A `Cookie` header holding a state the callback should accept. */
function issuedCookie(origin: 'login' | 'register' = 'login', ageMs = 1000, state = STATE): string {
  return stateCookieHeader(STATE_COOKIE, `${state}|${Date.now() - ageMs}|${origin}`, false).split(';')[0]
}

/** An id token carrying these claims. Only the payload is ever read. */
function idToken(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
}

function okToken(claims: Record<string, unknown>) {
  return () => new Response(JSON.stringify({ id_token: idToken(claims) }), { status: 200 })
}

const VERIFIED = { sub: '10769150350006150715', email: 'ada@example.com', email_verified: true, name: 'Ada Lovelace' }

/** Drive the action once. */
async function callback(options: {
  cookie?: string | null
  state?: string
  code?: string
  error?: string
} = {}) {
  const query: Record<string, string> = {}
  if (options.error)
    query.error = options.error
  query.state = options.state ?? STATE
  query.code = options.code ?? 'auth-code'

  const response: Response = await (await handler()).handle({
    headers: { get: (key: string) => (key.toLowerCase() === 'cookie' ? (options.cookie ?? null) : null) },
    get: (key: string) => query[key],
    url: 'https://wildloop.org/api/auth/google/callback',
  })

  const setCookies = response.headers.getSetCookie()
  const location = response.headers.get('location') ?? ''
  return {
    response,
    location,
    setCookies,
    /** The `error=` the page is told to show, or null on success. */
    reason: new URL(location, 'https://wildloop.org').searchParams.get('error'),
    page: location.split('?')[0],
    handoff: setCookies.find(c => c.startsWith('wl_google_handoff=')) ?? null,
  }
}

const identityWrites = () => queries.filter(q => q.text.includes('INSERT INTO user_identities'))
const userWrites = () => queries.filter(q => q.text.includes('INSERT INTO users'))

beforeEach(() => {
  google.clientId = 'client-id'
  google.clientSecret = 'client-secret'
  queries = []
  exchanges = []
  rows = {}
  logins = []
  sessionFails = false
  identityWriteFails = false
  tokenResponse = okToken(VERIFIED)
  globalThis.fetch = stubFetch
  process.env.APP_URL = 'https://wildloop.org'
})

// ── the state check ──────────────────────────────────────────────────────────

describe('before anything is exchanged', () => {
  /*
   * The check the whole flow rests on.
   *
   * Without it, anybody who can make the browser visit this URL with a code of
   * their choosing gets a session as whoever that code belongs to. The code is
   * never exchanged when the state does not match, so this also has to happen
   * before the token request goes out.
   */
  it('refuses a callback whose state was not the one issued', async () => {
    const result = await callback({ cookie: issuedCookie(), state: 'b'.repeat(64) })
    expect(result.reason).toBe('google-expired')
    expect(exchanges).toHaveLength(0)
    expect(queries).toHaveLength(0)
  })

  it('refuses a callback with no state cookie at all', async () => {
    const result = await callback({ cookie: null })
    expect(result.reason).toBe('google-expired')
    expect(exchanges).toHaveLength(0)
  })

  it('refuses a state left over from an abandoned sign-in', async () => {
    // Eleven minutes, against a ten-minute lifetime.
    const result = await callback({ cookie: issuedCookie('login', 11 * 60 * 1000) })
    expect(result.reason).toBe('google-expired')
    expect(exchanges).toHaveLength(0)
  })

  it('refuses a state too short to be unguessable', async () => {
    const short = 'abc'
    const result = await callback({ cookie: issuedCookie('login', 1000, short), state: short })
    expect(result.reason).toBe('google-expired')
    expect(exchanges).toHaveLength(0)
  })

  it('tells the visitor when they pressed Cancel at Google', async () => {
    const result = await callback({ cookie: issuedCookie(), error: 'access_denied' })
    expect(result.reason).toBe('google-cancelled')
    expect(exchanges).toHaveLength(0)
  })

  it('does not try to exchange a callback that arrived without a code', async () => {
    const result = await callback({ cookie: issuedCookie(), code: '' })
    expect(result.reason).toBe('google-failed')
    expect(exchanges).toHaveLength(0)
  })

  it('says so when Google is not configured, rather than exchanging nothing', async () => {
    google.clientId = undefined
    const result = await callback({ cookie: issuedCookie() })
    expect(result.reason).toBe('google-unavailable')
    expect(exchanges).toHaveLength(0)
  })

  it('spends the state cookie on every refusal', async () => {
    // Otherwise a state survives its own failed attempt and can be replayed.
    for (const options of [
      { cookie: issuedCookie(), state: 'b'.repeat(64) },
      { cookie: issuedCookie(), error: 'access_denied' },
      { cookie: issuedCookie(), code: '' },
    ]) {
      const result = await callback(options)
      expect(result.setCookies.some(c => c.startsWith(`${STATE_COOKIE}=;`) && c.includes('Max-Age=0'))).toBe(true)
    }
  })
})

// ── the exchange itself ──────────────────────────────────────────────────────

describe('the token exchange', () => {
  it('asks Google to trade the code, with the same redirect URI it was sent', async () => {
    await callback({ cookie: issuedCookie() })
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0].url).toBe('https://oauth2.googleapis.com/token')
    expect(exchanges[0].body).toEqual({
      code: 'auth-code',
      client_id: 'client-id',
      client_secret: 'client-secret',
      // Google compares this against the URI the authorization request carried.
      // A mismatch is refused there, so it has to be derived the same way.
      redirect_uri: 'https://wildloop.org/api/auth/google/callback',
      grant_type: 'authorization_code',
    })
  })

  it('gives up when Google refuses the exchange', async () => {
    tokenResponse = () => new Response('{"error":"invalid_grant"}', { status: 400 })
    const result = await callback({ cookie: issuedCookie() })
    expect(result.reason).toBe('google-failed')
    expect(queries).toHaveLength(0)
  })

  it('gives up when the token endpoint cannot be reached', async () => {
    tokenResponse = () => Promise.reject(new Error('ECONNREFUSED'))
    const result = await callback({ cookie: issuedCookie() })
    expect(result.reason).toBe('google-failed')
  })

  it('gives up on a response that is not a token', async () => {
    // A body with no id_token leaves an empty payload to decode, and the parse
    // has to fail as a refusal rather than as an unhandled throw.
    for (const body of ['{}', '{"id_token":"not-a-jwt"}', 'not json at all']) {
      tokenResponse = () => new Response(body, { status: 200 })
      const result = await callback({ cookie: issuedCookie() })
      expect(result.reason, body).toBe('google-failed')
    }
  })

  it('never opens a session from a token it could not read', async () => {
    tokenResponse = () => new Response('{}', { status: 200 })
    const result = await callback({ cookie: issuedCookie() })
    expect(result.handoff).toBeNull()
    expect(queries).toHaveLength(0)
  })
})

// ── who this is ──────────────────────────────────────────────────────────────

describe('deciding the account', () => {
  it('signs in an account that has used Google before', async () => {
    rows.identityUserId = 42
    const result = await callback({ cookie: issuedCookie() })

    expect(result.reason).toBeNull()
    expect(result.handoff).toContain('token-for-42')
    // Already recorded, so nothing new is written.
    expect(identityWrites()).toHaveLength(0)
    expect(userWrites()).toHaveLength(0)
  })

  it('links a Google account to the user who already has that address', async () => {
    rows.userByEmail = { id: 7, email: 'ada@example.com' }
    const result = await callback({ cookie: issuedCookie() })

    expect(result.reason).toBeNull()
    expect(result.handoff).toContain('token-for-7')
    expect(userWrites()).toHaveLength(0)
    expect(identityWrites()).toHaveLength(1)
    expect(identityWrites()[0].values).toContain(VERIFIED.sub)
  })

  it('creates an account when nothing matches', async () => {
    rows.createdId = 99
    const result = await callback({ cookie: issuedCookie() })

    expect(result.reason).toBeNull()
    expect(result.handoff).toContain('token-for-99')
    expect(userWrites()).toHaveLength(1)
    expect(userWrites()[0].values).toContain('ada@example.com')
    expect(userWrites()[0].values).toContain('Ada Lovelace')
    expect(identityWrites()).toHaveLength(1)
  })

  /*
   * The account-takeover case, at the point where it would actually happen.
   *
   * `decideLink` refuses this and has its own test; this one proves the action
   * honours the refusal rather than carrying on — no session, no rows, and a
   * message that says which of the two it was.
   */
  it('refuses to link an address Google has not verified', async () => {
    tokenResponse = okToken({ ...VERIFIED, email_verified: false })
    rows.userByEmail = { id: 7, email: 'ada@example.com' }
    const result = await callback({ cookie: issuedCookie() })

    expect(result.reason).toBe('google-unverified')
    expect(result.handoff).toBeNull()
    expect(identityWrites()).toHaveLength(0)
    expect(userWrites()).toHaveLength(0)
  })

  it('refuses to create an account from an unverified address either', async () => {
    tokenResponse = okToken({ ...VERIFIED, email_verified: false })
    const result = await callback({ cookie: issuedCookie() })
    expect(result.reason).toBe('google-unverified')
    expect(userWrites()).toHaveLength(0)
  })

  it('reads the string "true" as verified, which Google has sent', async () => {
    tokenResponse = okToken({ ...VERIFIED, email_verified: 'true' })
    rows.createdId = 99
    expect((await callback({ cookie: issuedCookie() })).reason).toBeNull()
  })

  it('looks the identity up by subject, not by address', async () => {
    rows.identityUserId = 42
    await callback({ cookie: issuedCookie() })
    const lookup = queries.find(q => q.text.includes('FROM user_identities'))
    // The address on a Google account can change; the subject cannot.
    expect(lookup?.values).toContain(VERIFIED.sub)
    expect(lookup?.values).not.toContain('ada@example.com')
  })

  it('matches an existing address regardless of case', async () => {
    tokenResponse = okToken({ ...VERIFIED, email: 'Ada@EXAMPLE.com' })
    rows.userByEmail = { id: 7, email: 'ada@example.com' }
    await callback({ cookie: issuedCookie() })
    expect(queries.find(q => q.text.includes('FROM users'))?.values).toContain('ada@example.com')
  })

  it('gives a created account a password nobody holds', async () => {
    rows.createdId = 99
    await callback({ cookie: issuedCookie() })
    const password = String(userWrites()[0].values.find(v => String(v).startsWith('bcrypt(')))
    // 32 random bytes, hex. Not empty, not the address, not a constant.
    expect(password).toMatch(/^bcrypt\([0-9a-f]{64}\)$/)
  })

  it('gives up rather than guessing when the account could not be created', async () => {
    rows.createdId = null
    const result = await callback({ cookie: issuedCookie() })
    expect(result.reason).toBe('google-failed')
    expect(result.handoff).toBeNull()
    expect(identityWrites()).toHaveLength(0)
  })
})

// ── the session ──────────────────────────────────────────────────────────────

describe('handing the session over', () => {
  it('carries the token in a short-lived cookie no script can read', async () => {
    rows.identityUserId = 42
    const result = await callback({ cookie: issuedCookie() })

    expect(result.handoff).toContain('HttpOnly')
    expect(result.handoff).toContain('Max-Age=60')
    expect(result.handoff).toContain('SameSite=Lax')
  })

  it('never puts the token in the URL', async () => {
    rows.identityUserId = 42
    const result = await callback({ cookie: issuedCookie() })
    // A token in the query or fragment is written into browser history, and
    // for a query into every log between here and there.
    expect(result.location).not.toContain('token-for-42')
    expect(result.location).toBe('/login?google=1')
  })

  it('spends the state cookie on the way out', async () => {
    rows.identityUserId = 42
    const result = await callback({ cookie: issuedCookie() })
    expect(result.setCookies.some(c => c.startsWith(`${STATE_COOKIE}=;`) && c.includes('Max-Age=0'))).toBe(true)
  })

  it('opens the session for the account it decided on, and no other', async () => {
    rows.identityUserId = 42
    await callback({ cookie: issuedCookie() })
    expect(logins).toHaveLength(1)
    expect(logins[0].userId).toBe(42)
  })

  it('remembers the session, because nobody chose a length', async () => {
    rows.identityUserId = 42
    await callback({ cookie: issuedCookie() })
    // resolveBrowserSessionPolicy(true) — the "remember me" branch, not the
    // twelve-hour one. Somebody who signs in with a provider will use it again,
    // and a twelve-hour session would sign them out daily with no way to say
    // otherwise, since the provider button carries no "remember me".
    expect(logins[0].options).toEqual({ expiresInMinutes: 43_200, withRefreshToken: true })
  })

  /*
   * The ordering the source comments claim, made true.
   *
   * If the identity row were written first, a session that then failed to open
   * would leave a row saying this Google account belongs to a user who has
   * never signed in — and the next attempt would "sign in" to it without any
   * further check.
   */
  it('writes no identity when the session could not be opened', async () => {
    sessionFails = true
    rows.createdId = 99
    const result = await callback({ cookie: issuedCookie() })

    expect(result.reason).toBe('google-failed')
    expect(result.handoff).toBeNull()
    expect(identityWrites()).toHaveLength(0)
  })

  it('still signs somebody in when recording the identity fails', async () => {
    /*
     * The row is bookkeeping, and the session is already open by the time it is
     * written. Letting a failed insert throw would hand somebody Google has
     * vouched for an error page while a valid session sat in a cookie — and on
     * a unique-index clash, which is the likely cause, it would happen every
     * time they tried again.
     */
    identityWriteFails = true
    rows.userByEmail = { id: 7, email: 'ada@example.com' }
    const result = await callback({ cookie: issuedCookie() })

    expect(result.reason).toBeNull()
    expect(result.handoff).toContain('token-for-7')
    expect(identityWrites()).toHaveLength(1)
  })
})

// ── where the visitor ends up ────────────────────────────────────────────────

describe('coming back to the page it started from', () => {
  it('returns to the sign-up page when that is where the button was', async () => {
    rows.createdId = 99
    expect((await callback({ cookie: issuedCookie('register') })).page).toBe('/register')
  })

  it('returns to the sign-up page on failure too', async () => {
    tokenResponse = () => new Response('{}', { status: 200 })
    expect((await callback({ cookie: issuedCookie('register') })).page).toBe('/register')
  })

  it('returns to the sign-in page by default', async () => {
    rows.identityUserId = 42
    expect((await callback({ cookie: issuedCookie('login') })).page).toBe('/login')
  })

  /*
   * This value decides where a browser is sent, and it comes back from a
   * cookie. Anything it can be talked into holding is an open redirect, so it
   * is matched against two known pages rather than echoed.
   */
  it('cannot be talked into sending the browser anywhere else', async () => {
    rows.identityUserId = 42
    for (const forged of ['https://attacker.example', '//attacker.example', '/register/../../evil']) {
      const cookie = stateCookieHeader(STATE_COOKIE, `${STATE}|${Date.now() - 1000}|${forged}`, false).split(';')[0]
      const result = await callback({ cookie })
      expect(['/login', '/register'], forged).toContain(result.page)
    }
  })

  it('never redirects anywhere off-site', async () => {
    rows.identityUserId = 42
    const result = await callback({ cookie: issuedCookie() })
    expect(result.location.startsWith('/')).toBe(true)
    expect(result.location.startsWith('//')).toBe(false)
  })

  it('tells the browser not to keep any of this', async () => {
    rows.identityUserId = 42
    const result = await callback({ cookie: issuedCookie() })
    expect(result.response.headers.get('cache-control')).toBe('no-store')
  })

  it('tells it the same on the way to an error', async () => {
    // These responses carry the Set-Cookie that spends the state. A cached one
    // would let the browser replay the redirect, and show a stale reason for a
    // sign-in that has since been abandoned.
    for (const options of [
      { cookie: null },
      { cookie: issuedCookie(), error: 'access_denied' },
      { cookie: issuedCookie(), code: '' },
    ])
      expect((await callback(options)).response.headers.get('cache-control')).toBe('no-store')
  })
})

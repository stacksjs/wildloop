import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { APPLE_HANDOFF_COOKIE, APPLE_STATE_COOKIE, crossSiteStateCookieHeader, HANDOFF_COOKIE } from '../../app/Support/socialRequest'

/**
 * Signing in with Apple, driven end to end against a stubbed token endpoint —
 * the same harness as google-callback.test.ts, because the flow is the same
 * flow with Apple's habits added.
 *
 * Nothing real is contacted. `fetch` is replaced, so Apple's token endpoint is
 * a value this file controls, and the database is a recorder that reports
 * what it was asked rather than storing anything. What is under test is
 * Apple's half: a POST callback with no CSRF token, a client secret minted
 * from a key, an issuer and audience to check, a name that arrives once, and
 * an address that may be a relay.
 */

;(globalThis as any).Action = class {
  constructor(spec: any) {
    return spec
  }
}

let queries: { text: string, values: unknown[] }[] = []
let rows: {
  identityUserId?: number | null
  userByEmail?: { id: number, email: string } | null
  createdId?: number | null
}
let sessionFails = false
let logins: { userId: number, options: Record<string, unknown> }[] = []
let exchanges: { url: string, body: Record<string, string> }[] = []
let tokenResponse: () => Promise<Response> | Response
/** What `Auth.getUserFromToken` answers, for the session hand-off. */
let tokenUsers: Record<string, any> = {}

// Spread the real modules and put them back afterwards: `mock.module` is
// process-wide, and other suites import these. See google-callback.test.ts.
const realOrm = await import('@stacksjs/orm')
const realAuth = await import('@stacksjs/auth')
const realSecurity = await import('@stacksjs/security')
const realFetch = globalThis.fetch
const realAppUrl = process.env.APP_URL

const { config } = await import('@stacksjs/config')
const apple = (config as any).auth.social.apple as { clientId: string, teamId: string, keyId: string, privateKey: string }
const realCredentials = { clientId: apple.clientId, teamId: apple.teamId, keyId: apple.keyId, privateKey: apple.privateKey }

/*
 * `response` is another global the server injects at boot. The redirect uses
 * it for its one JSON answer, the 503 when Apple is not configured.
 */
const realResponseHelper = (globalThis as any).response
;(globalThis as any).response = {
  json: (body: unknown, status = 200) => Response.json(body, { status }),
}

afterAll(() => {
  mock.module('@stacksjs/orm', () => realOrm)
  mock.module('@stacksjs/auth', () => realAuth)
  mock.module('@stacksjs/security', () => realSecurity)
  Object.assign(apple, realCredentials)
  ;(globalThis as any).response = realResponseHelper
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
    ...realAuth.Auth,
    async loginUsingId(userId: number, options: Record<string, unknown>) {
      logins.push({ userId, options })
      if (sessionFails)
        throw new Error('no session')
      return { token: `token-for-${userId}` }
    },
    async getUserFromToken(token: string) {
      return tokenUsers[token] ?? null
    },
  },
  resolveBrowserSessionPolicy: (remember: boolean) => ({ expiresInMinutes: remember ? 43_200 : 720, withRefreshToken: remember }),
}))

mock.module('@stacksjs/security', () => ({ ...realSecurity, makeHash: async (value: string) => `bcrypt(${value})` }))

const stubFetch = (async (url: any, init: any) => {
  exchanges.push({ url: String(url), body: Object.fromEntries(new URLSearchParams(String(init?.body))) })
  return tokenResponse()
}) as typeof fetch

const callbackAction = async () => (await import('../../app/Actions/Auth/AppleCallbackAction')).default as any
const redirectAction = async () => (await import('../../app/Actions/Auth/AppleRedirectAction')).default as any
const sessionAction = async () => (await import('../../app/Actions/Auth/AppleSessionAction')).default as any

// ── helpers ──────────────────────────────────────────────────────────────────

const CLIENT_ID = 'org.wildloop.signin'
const STATE = 'a1b2c3d4'.repeat(8)
let keyPem = ''
let publicKey: CryptoKey

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  keyPem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`
  publicKey = pair.publicKey
})

function issuedCookie(origin: 'login' | 'register' = 'login', ageMs = 1000, state = STATE): string {
  return crossSiteStateCookieHeader(APPLE_STATE_COOKIE, `${state}|${Date.now() - ageMs}|${origin}`).split(';')[0]
}

function idToken(claims: Record<string, unknown>): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
}

function okToken(claims: Record<string, unknown>) {
  return () => new Response(JSON.stringify({ id_token: idToken(claims) }), { status: 200 })
}

const VERIFIED = {
  iss: 'https://appleid.apple.com',
  aud: CLIENT_ID,
  sub: '001234.abcdef0123456789.0123',
  email: 'ada@icloud.com',
  email_verified: 'true',
  is_private_email: 'false',
}

const FIRST_TIME_USER = JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' }, email: 'ada@icloud.com' })

/** Drive the callback once, as Apple's form post would. */
async function callback(options: {
  cookie?: string | null
  state?: string
  code?: string
  error?: string
  user?: string
} = {}) {
  const form: Record<string, string> = {}
  if (options.error)
    form.error = options.error
  form.state = options.state ?? STATE
  form.code = options.code ?? 'auth-code'
  if (options.user !== undefined)
    form.user = options.user

  const response: Response = await (await callbackAction()).handle({
    headers: { get: (key: string) => (key.toLowerCase() === 'cookie' ? (options.cookie ?? null) : null) },
    get: (key: string) => form[key],
    url: 'https://wildloop.org/api/auth/apple/callback',
  })

  const setCookies = response.headers.getSetCookie()
  const location = response.headers.get('location') ?? ''
  return {
    response,
    location,
    setCookies,
    reason: new URL(location, 'https://wildloop.org').searchParams.get('error'),
    page: location.split('?')[0],
    handoff: setCookies.find(c => c.startsWith(`${APPLE_HANDOFF_COOKIE}=`)) ?? null,
  }
}

const identityWrites = () => queries.filter(q => q.text.includes('INSERT INTO user_identities'))
const userWrites = () => queries.filter(q => q.text.includes('INSERT INTO users'))

beforeEach(() => {
  Object.assign(apple, { clientId: CLIENT_ID, teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: keyPem })
  queries = []
  exchanges = []
  rows = {}
  logins = []
  tokenUsers = {}
  sessionFails = false
  tokenResponse = okToken(VERIFIED)
  globalThis.fetch = stubFetch
  process.env.APP_URL = 'https://wildloop.org'
})

// ── starting out ─────────────────────────────────────────────────────────────

describe('the redirect to Apple', () => {
  async function redirect(from?: string): Promise<Response> {
    return await (await redirectAction()).handle({ get: (key: string) => (key === 'from' ? from : undefined), url: 'https://wildloop.org/api/auth/apple/redirect' })
  }

  it('sends the browser to Apple with a form-post callback on our own domain', async () => {
    const response = await redirect()
    expect(response.status).toBe(302)
    const url = new URL(response.headers.get('location')!)
    expect(url.origin).toBe('https://appleid.apple.com')
    expect(url.searchParams.get('redirect_uri')).toBe('https://wildloop.org/api/auth/apple/callback')
    expect(url.searchParams.get('response_mode')).toBe('form_post')
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
  })

  /*
   * The cookie attribute the whole flow depends on. Apple comes back with a
   * cross-site form POST, and browsers withhold a Lax cookie from exactly
   * that: with Google's cookie, every Apple sign-in would come back "expired".
   */
  it('keeps the state in a cookie that survives Apple\'s cross-site POST', async () => {
    const cookie = (await redirect()).headers.get('set-cookie')!
    expect(cookie.startsWith(`${APPLE_STATE_COOKIE}=`)).toBe(true)
    expect(cookie).toContain('SameSite=None')
    expect(cookie).toContain('Secure')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Max-Age=600')
  })

  it('puts the same state in the cookie and in the URL', async () => {
    const response = await redirect()
    const state = new URL(response.headers.get('location')!).searchParams.get('state')!
    const cookie = decodeURIComponent(response.headers.get('set-cookie')!.split(';')[0].split('=')[1])
    expect(state).toMatch(/^[0-9a-f]{64}$/)
    expect(cookie.split('|')[0]).toBe(state)
  })

  it('remembers the sign-up page, and nothing else it is told', async () => {
    const origin = async (from?: string) => decodeURIComponent((await redirect(from)).headers.get('set-cookie')!.split(';')[0]).split('|')[2]
    expect(await origin('register')).toBe('register')
    expect(await origin('https://attacker.example')).toBe('login')
    expect(await origin()).toBe('login')
  })

  it('is not offered at all until all four credentials are set', async () => {
    for (const missing of ['clientId', 'teamId', 'keyId', 'privateKey'] as const) {
      Object.assign(apple, { clientId: CLIENT_ID, teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: keyPem, [missing]: '' })
      expect((await redirect()).status, missing).toBe(503)
    }
  })
})

// ── before anything is exchanged ─────────────────────────────────────────────

describe('before anything is exchanged', () => {
  /*
   * Apple posts from its own origin, so the callback cannot carry our CSRF
   * token and opts out of that check. The state is what stands in for it, so
   * these refusals are the CSRF protection for this endpoint.
   */
  it('opts out of the CSRF check, because Apple cannot carry our token', async () => {
    expect((await callbackAction()).skipCsrf).toBe(true)
    expect((await callbackAction()).method).toBe('POST')
  })

  it('refuses a callback whose state was not the one issued', async () => {
    const result = await callback({ cookie: issuedCookie(), state: 'b'.repeat(64) })
    expect(result.reason).toBe('apple-expired')
    expect(exchanges).toHaveLength(0)
    expect(queries).toHaveLength(0)
  })

  it('refuses a callback with no state cookie at all', async () => {
    const result = await callback({ cookie: null })
    expect(result.reason).toBe('apple-expired')
    expect(exchanges).toHaveLength(0)
  })

  it('refuses a state left over from an abandoned sign-in', async () => {
    const result = await callback({ cookie: issuedCookie('login', 11 * 60 * 1000) })
    expect(result.reason).toBe('apple-expired')
    expect(exchanges).toHaveLength(0)
  })

  it('tells the visitor when they cancelled at Apple', async () => {
    const result = await callback({ cookie: issuedCookie(), error: 'user_cancelled_authorize', code: '' })
    expect(result.reason).toBe('apple-cancelled')
    expect(exchanges).toHaveLength(0)
  })

  it('does not try to exchange a callback that arrived without a code', async () => {
    expect((await callback({ cookie: issuedCookie(), code: '' })).reason).toBe('apple-failed')
    expect(exchanges).toHaveLength(0)
  })

  it('says so when Apple is not configured', async () => {
    apple.privateKey = ''
    const result = await callback({ cookie: issuedCookie() })
    expect(result.reason).toBe('apple-unavailable')
    expect(exchanges).toHaveLength(0)
  })

  it('spends the state cookie on every refusal, with the attributes it was set with', async () => {
    for (const options of [
      { cookie: issuedCookie(), state: 'b'.repeat(64) },
      { cookie: issuedCookie(), error: 'user_cancelled_authorize' },
      { cookie: issuedCookie(), code: '' },
    ]) {
      const spent = (await callback(options)).setCookies.find(c => c.startsWith(`${APPLE_STATE_COOKIE}=;`))
      expect(spent).toContain('Max-Age=0')
      expect(spent).toContain('SameSite=None')
      expect(spent).toContain('Secure')
    }
  })
})

// ── the exchange ─────────────────────────────────────────────────────────────

describe('the token exchange', () => {
  it('asks Apple to trade the code, with the same redirect URI it was sent', async () => {
    rows.createdId = 99
    await callback({ cookie: issuedCookie() })
    expect(exchanges).toHaveLength(1)
    expect(exchanges[0].url).toBe('https://appleid.apple.com/auth/token')
    expect(exchanges[0].body).toMatchObject({
      client_id: CLIENT_ID,
      code: 'auth-code',
      grant_type: 'authorization_code',
      redirect_uri: 'https://wildloop.org/api/auth/apple/callback',
    })
  })

  /*
   * The secret Apple will check. Minted for this exchange from the key, so it
   * must verify with the key's public half and name our team and Services ID
   * — anything else is `invalid_client` from Apple and nothing more.
   */
  it('sends a client secret minted from the key, for this app', async () => {
    rows.createdId = 99
    await callback({ cookie: issuedCookie() })
    const [header, payload, signature] = exchanges[0].body.client_secret.split('.')

    expect(await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      Buffer.from(signature, 'base64url'),
      new TextEncoder().encode(`${header}.${payload}`),
    )).toBe(true)
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({ iss: 'TEAM123456', sub: CLIENT_ID, aud: 'https://appleid.apple.com' })
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' })
  })

  it('gives up, and says so in the log, when the key will not sign', async () => {
    apple.privateKey = 'not a key at all'
    const result = await callback({ cookie: issuedCookie() })
    expect(result.reason).toBe('apple-failed')
    expect(exchanges).toHaveLength(0)
    expect(userWrites()).toHaveLength(0)
  })

  it('gives up when Apple refuses the exchange', async () => {
    tokenResponse = () => new Response('{"error":"invalid_client"}', { status: 400 })
    const result = await callback({ cookie: issuedCookie() })
    expect(result.reason).toBe('apple-failed')
    expect(queries).toHaveLength(0)
  })

  it('gives up when the token endpoint cannot be reached', async () => {
    tokenResponse = () => Promise.reject(new Error('ECONNREFUSED'))
    expect((await callback({ cookie: issuedCookie() })).reason).toBe('apple-failed')
  })

  it('gives up on a response that is not a token', async () => {
    for (const body of ['{}', '{"id_token":"not-a-jwt"}', 'not json at all', 'null']) {
      tokenResponse = () => new Response(body, { status: 200 })
      const result = await callback({ cookie: issuedCookie() })
      expect(result.reason, body).toBe('apple-failed')
      expect(queries, body).toHaveLength(0)
    }
  })

  it('refuses a token minted for some other app', async () => {
    tokenResponse = okToken({ ...VERIFIED, aud: 'com.someone.else' })
    const result = await callback({ cookie: issuedCookie() })
    expect(result.reason).toBe('apple-failed')
    expect(queries).toHaveLength(0)
  })
})

// ── who this is ──────────────────────────────────────────────────────────────

describe('deciding the account', () => {
  it('signs in an Apple ID that has used Wildloop before, by subject', async () => {
    rows.identityUserId = 42
    const result = await callback({ cookie: issuedCookie() })

    expect(result.reason).toBeNull()
    expect(result.handoff).toContain('token-for-42')
    const lookup = queries.find(q => q.text.includes('FROM user_identities'))
    expect(lookup?.values).toContain('apple')
    expect(lookup?.values).toContain(VERIFIED.sub)
    expect(identityWrites()).toHaveLength(0)
    expect(userWrites()).toHaveLength(0)
  })

  it('links an Apple ID to the account that already has its verified address', async () => {
    rows.userByEmail = { id: 7, email: 'ada@icloud.com' }
    const result = await callback({ cookie: issuedCookie(), user: FIRST_TIME_USER })

    expect(result.handoff).toContain('token-for-7')
    expect(userWrites()).toHaveLength(0)
    expect(identityWrites()).toHaveLength(1)
    expect(identityWrites()[0].values).toEqual(expect.arrayContaining([7, 'apple', VERIFIED.sub, 'ada@icloud.com']))
  })

  /*
   * The account-takeover case. Apple says the address is unverified, so it is
   * a claim, and a claim does not open somebody else's account.
   */
  it('refuses to link an address Apple has not verified', async () => {
    tokenResponse = okToken({ ...VERIFIED, email_verified: 'false' })
    rows.userByEmail = { id: 7, email: 'ada@icloud.com' }
    const result = await callback({ cookie: issuedCookie() })

    expect(result.reason).toBe('apple-unverified')
    expect(result.handoff).toBeNull()
    expect(identityWrites()).toHaveLength(0)
    expect(userWrites()).toHaveLength(0)
  })

  it('creates an account named from the first sign-in\'s user field', async () => {
    rows.createdId = 99
    const result = await callback({ cookie: issuedCookie(), user: FIRST_TIME_USER })

    expect(result.handoff).toContain('token-for-99')
    expect(userWrites()).toHaveLength(1)
    expect(userWrites()[0].values).toContain('Ada Lovelace')
    expect(userWrites()[0].values).toContain('ada@icloud.com')
    expect(identityWrites()).toHaveLength(1)
  })

  /*
   * The user field is posted by the browser, not signed by Apple. It may name
   * somebody, but the address that decides the account is the id token's.
   */
  it('never takes the address from the unsigned user field', async () => {
    rows.createdId = 99
    const forged = JSON.stringify({ name: { firstName: 'Ada' }, email: 'victim@example.com' })
    await callback({ cookie: issuedCookie(), user: forged })

    expect(queries.find(q => q.text.includes('FROM users'))?.values).toEqual(['ada@icloud.com'])
    expect(userWrites()[0].values).not.toContain('victim@example.com')
  })

  it('falls back to the address when Apple sent no name, as on any later sign-in', async () => {
    rows.createdId = 99
    await callback({ cookie: issuedCookie() })
    expect(userWrites()[0].values).toContain('ada')
  })

  it('creates an account for a Hide My Email relay, without naming it after the relay', async () => {
    tokenResponse = okToken({ ...VERIFIED, email: 'x7k2p9q4mz@privaterelay.appleid.com', is_private_email: 'true' })
    rows.createdId = 99
    const result = await callback({ cookie: issuedCookie() })

    expect(result.handoff).toContain('token-for-99')
    expect(userWrites()[0].values).toContain('x7k2p9q4mz@privaterelay.appleid.com')
    expect(userWrites()[0].values).toContain('Wildloop athlete')
    expect(userWrites()[0].values).not.toContain('x7k2p9q4mz')
  })

  it('refuses an Apple ID that shares no address at all', async () => {
    tokenResponse = okToken({ ...VERIFIED, email: undefined })
    const result = await callback({ cookie: issuedCookie() })
    expect(result.reason).toBe('apple-failed')
    expect(userWrites()).toHaveLength(0)
  })
})

// ── nothing half-made ────────────────────────────────────────────────────────

describe('an abandoned or failed flow', () => {
  /*
   * The acceptance line: an abandoned flow leaves no half-created user. The
   * account is created only after Apple's exchange has succeeded, so every
   * way of not getting that far writes nothing at all.
   */
  it('writes no user for any failure before the exchange succeeds', async () => {
    const attempts: Array<() => Promise<unknown>> = [
      () => callback({ cookie: null }),
      () => callback({ cookie: issuedCookie(), error: 'user_cancelled_authorize' }),
      () => callback({ cookie: issuedCookie('login', 11 * 60 * 1000) }),
      async () => {
        tokenResponse = () => new Response('{"error":"invalid_grant"}', { status: 400 })
        return await callback({ cookie: issuedCookie() })
      },
    ]
    for (const attempt of attempts)
      await attempt()
    expect(userWrites()).toHaveLength(0)
    expect(identityWrites()).toHaveLength(0)
    expect(logins).toHaveLength(0)
  })

  it('writes no identity when the session could not be opened', async () => {
    sessionFails = true
    rows.createdId = 99
    const result = await callback({ cookie: issuedCookie() })
    expect(result.reason).toBe('apple-failed')
    expect(result.handoff).toBeNull()
    expect(identityWrites()).toHaveLength(0)
  })
})

// ── handing over ─────────────────────────────────────────────────────────────

describe('handing the session over', () => {
  it('carries the token in Apple\'s own short-lived cookie, never in the URL', async () => {
    rows.identityUserId = 42
    const result = await callback({ cookie: issuedCookie() })

    expect(result.handoff).toContain('HttpOnly')
    expect(result.handoff).toContain('Max-Age=60')
    expect(result.location).toBe('/login?apple=1')
    expect(result.location).not.toContain('token-for-42')
    // Google's hand-off cookie is not touched by an Apple sign-in.
    expect(result.setCookies.some(c => c.startsWith(`${HANDOFF_COOKIE}=`))).toBe(false)
  })

  it('answers the POST with a 303, so the browser follows with a GET', async () => {
    rows.identityUserId = 42
    expect((await callback({ cookie: issuedCookie() })).response.status).toBe(303)
    expect((await callback({ cookie: null })).response.status).toBe(303)
  })

  it('returns to the sign-up page when that is where it began', async () => {
    rows.createdId = 99
    expect((await callback({ cookie: issuedCookie('register') })).location).toBe('/register?apple=1')
    expect((await callback({ cookie: issuedCookie('register'), error: 'user_cancelled_authorize' })).page).toBe('/register')
  })

  it('remembers the session, as Google\'s does', async () => {
    rows.identityUserId = 42
    await callback({ cookie: issuedCookie() })
    expect(logins[0]).toEqual({ userId: 42, options: { expiresInMinutes: 43_200, withRefreshToken: true } })
  })

  it('tells the browser not to keep any of it', async () => {
    rows.identityUserId = 42
    expect((await callback({ cookie: issuedCookie() })).response.headers.get('cache-control')).toBe('no-store')
    expect((await callback({ cookie: null })).response.headers.get('cache-control')).toBe('no-store')
  })

  it('trades Apple\'s hand-off cookie for the session, once', async () => {
    tokenUsers['token-for-42'] = { id: 42, email: 'ada@icloud.com', name: 'Ada Lovelace' }
    const handle = (await sessionAction()).handle
    const withCookie = (cookie: string | null) => handle({ headers: { get: (key: string) => (key === 'cookie' ? cookie : null) } })

    const spent = await withCookie(`${APPLE_HANDOFF_COOKIE}=token-for-42`) as Response
    expect(spent.status).toBe(200)
    expect((await spent.json()).token).toBe('token-for-42')
    expect(spent.headers.get('set-cookie')).toContain(`${APPLE_HANDOFF_COOKIE}=;`)

    // Google's cookie does not open an Apple hand-off.
    expect((await withCookie(`${HANDOFF_COOKIE}=token-for-42`) as Response).status).toBe(401)
  })
})

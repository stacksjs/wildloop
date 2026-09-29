import { describe, expect, it } from 'bun:test'
import { STATE_LIFETIME_MS } from '../../app/Support/socialIdentity'
import {
  clearCookieHeader,
  cookieValue,
  googleRedirectUri,
  HANDOFF_COOKIE,
  handoffCookieHeader,
  STATE_COOKIE,
  stateCookieHeader,
} from '../../app/Support/socialRequest'

/**
 * The request-shaped half of signing in with Google: the redirect URI, and the
 * cookies the state and the session travel in.
 *
 * `socialIdentity` decides things; this file only builds strings. That makes it
 * look like it cannot go wrong, which is why it is worth testing: every failure
 * here is silent. A redirect URI one character off is refused by Google before
 * our code runs, a cookie missing an attribute still works in development and
 * only fails once it is behind HTTPS, and a value that does not survive the
 * round trip reads as an expired sign-in rather than as a bug.
 */

const CALLBACK = '/api/auth/google/callback'

describe('googleRedirectUri', () => {
  it('builds the callback from APP_URL', () => {
    expect(googleRedirectUri({}, { APP_URL: 'https://wildloop.org' })).toBe(`https://wildloop.org${CALLBACK}`)
  })

  /*
   * The one Google refuses outright.
   *
   * The registered URI is matched character for character, so a trailing slash
   * on APP_URL turning into `org//api/...` is not a cosmetic difference — it
   * fails the whole flow, at Google, with an error page we never see.
   */
  it('does not double the slash when APP_URL ends in one', () => {
    expect(googleRedirectUri({}, { APP_URL: 'https://wildloop.org/' })).toBe(`https://wildloop.org${CALLBACK}`)
    expect(googleRedirectUri({}, { APP_URL: 'https://wildloop.org///' })).toBe(`https://wildloop.org${CALLBACK}`)
  })

  it('assumes https when APP_URL carries no scheme', () => {
    expect(googleRedirectUri({}, { APP_URL: 'wildloop.org' })).toBe(`https://wildloop.org${CALLBACK}`)
  })

  it('keeps an http scheme that was given on purpose', () => {
    // Local development registers an http origin, so this must not be upgraded.
    expect(googleRedirectUri({}, { APP_URL: 'http://localhost:3000' })).toBe(`http://localhost:3000${CALLBACK}`)
  })

  /*
   * The one that matters for security.
   *
   * This value decides where Google delivers an authorization code. The request
   * origin is derived from a Host header, which is attacker-supplied, so
   * whenever the app knows its own URL that is the only thing consulted.
   */
  it('ignores the request entirely when APP_URL is set', () => {
    const forged = { url: 'https://attacker.example/api/auth/google/callback' }
    expect(googleRedirectUri(forged, { APP_URL: 'https://wildloop.org' })).toBe(`https://wildloop.org${CALLBACK}`)
  })

  it('falls back to the origin the request arrived on when APP_URL is absent', () => {
    expect(googleRedirectUri({ url: 'http://127.0.0.1:3000/api/auth/google/redirect?from=register' }, {}))
      .toBe(`http://127.0.0.1:3000${CALLBACK}`)
  })

  it('treats a blank or whitespace APP_URL as absent', () => {
    // A set-but-empty variable is the usual shape of a half-configured box, and
    // reading it as a hostname would build `https:///api/...`.
    for (const APP_URL of ['', '   ', '\n'])
      expect(googleRedirectUri({ url: 'http://localhost:4000/x' }, { APP_URL })).toBe(`http://localhost:4000${CALLBACK}`)
  })

  it('has a last resort when there is neither APP_URL nor a usable request', () => {
    expect(googleRedirectUri({}, {})).toBe(`http://localhost:3000${CALLBACK}`)
  })
})

describe('cookie attributes', () => {
  const attributes = (header: string) => header.split(';').map(part => part.trim())

  it('keeps both cookies unreadable by script', () => {
    // The state cookie is the only copy of the CSRF token and the handoff
    // cookie is a live bearer token. Either one readable from script is the
    // whole point of using a cookie thrown away.
    expect(attributes(stateCookieHeader(STATE_COOKIE, 'abc'))).toContain('HttpOnly')
    expect(attributes(handoffCookieHeader(HANDOFF_COOKIE, 'token'))).toContain('HttpOnly')
    expect(attributes(clearCookieHeader(STATE_COOKIE))).toContain('HttpOnly')
  })

  /*
   * Lax, never Strict.
   *
   * The callback is a cross-site navigation: the browser is arriving from
   * accounts.google.com. A Strict cookie is withheld on exactly that request,
   * so the callback would find no state and every sign-in would come back
   * "expired" — for everybody, while looking like a configuration problem.
   */
  it('sends the cookies on the return trip from Google', () => {
    for (const header of [
      stateCookieHeader(STATE_COOKIE, 'abc'),
      handoffCookieHeader(HANDOFF_COOKIE, 'token'),
      clearCookieHeader(STATE_COOKIE),
    ]) {
      expect(attributes(header)).toContain('SameSite=Lax')
      expect(attributes(header)).not.toContain('SameSite=Strict')
    }
  })

  it('scopes every cookie to the whole site', () => {
    // The clear has to match the set on Path or the browser keeps the original
    // cookie alongside the expired one, and a spent state stays spendable.
    for (const header of [
      stateCookieHeader(STATE_COOKIE, 'abc'),
      handoffCookieHeader(HANDOFF_COOKIE, 'token'),
      clearCookieHeader(STATE_COOKIE),
    ])
      expect(attributes(header)).toContain('Path=/')
  })

  it('marks the cookies Secure in production and not in development', () => {
    expect(attributes(stateCookieHeader(STATE_COOKIE, 'abc', true))).toContain('Secure')
    expect(attributes(handoffCookieHeader(HANDOFF_COOKIE, 'token', true))).toContain('Secure')
    expect(attributes(clearCookieHeader(STATE_COOKIE, true))).toContain('Secure')
    // Not in development, where the dev server is plain http and a Secure
    // cookie would simply never be stored.
    expect(attributes(stateCookieHeader(STATE_COOKIE, 'abc', false))).not.toContain('Secure')
  })

  it('takes Secure from APP_ENV when it is not told', () => {
    const before = process.env.APP_ENV
    try {
      process.env.APP_ENV = 'production'
      expect(attributes(stateCookieHeader(STATE_COOKIE, 'abc'))).toContain('Secure')
      process.env.APP_ENV = 'development'
      expect(attributes(stateCookieHeader(STATE_COOKIE, 'abc'))).not.toContain('Secure')
    }
    finally {
      if (before === undefined)
        delete process.env.APP_ENV
      else process.env.APP_ENV = before
    }
  })

  /*
   * The comment in socialRequest says this matches `STATE_LIFETIME_MS`. Nothing
   * made that true, and the two can drift in either direction: a cookie that
   * outlives the check is harmless, but a cookie that dies first turns a valid
   * sign-in into "expired" with no way to tell it from a real refusal.
   */
  it('expires the state cookie exactly when the state itself expires', () => {
    const maxAge = Number(/Max-Age=(\d+)/.exec(stateCookieHeader(STATE_COOKIE, 'abc'))?.[1])
    expect(maxAge).toBe(STATE_LIFETIME_MS / 1000)
  })

  it('gives the handoff a minute and the clear no time at all', () => {
    expect(attributes(handoffCookieHeader(HANDOFF_COOKIE, 'token'))).toContain('Max-Age=60')
    expect(attributes(clearCookieHeader(STATE_COOKIE))).toContain('Max-Age=0')
  })

  it('clears the cookie by name with an empty value', () => {
    expect(clearCookieHeader(STATE_COOKIE).startsWith(`${STATE_COOKIE}=;`)).toBe(true)
  })
})

describe('cookieValue', () => {
  it('finds a cookie wherever it sits in the header', () => {
    const header = `first=1; ${STATE_COOKIE}=wanted; last=3`
    expect(cookieValue(header, STATE_COOKIE)).toBe('wanted')
    expect(cookieValue(`${STATE_COOKIE}=wanted`, STATE_COOKIE)).toBe('wanted')
    expect(cookieValue(`other=2; ${STATE_COOKIE}=wanted`, STATE_COOKIE)).toBe('wanted')
  })

  it('is nothing when there is no such cookie, or no header', () => {
    expect(cookieValue('other=2', STATE_COOKIE)).toBeNull()
    expect(cookieValue('', STATE_COOKIE)).toBeNull()
    expect(cookieValue(null, STATE_COOKIE)).toBeNull()
    expect(cookieValue(undefined, STATE_COOKIE)).toBeNull()
  })

  /*
   * Matched on the whole name.
   *
   * A check that accepted a cookie whose name merely contains the one we want
   * would let any other cookie on the domain stand in for the state — and a
   * subdomain can set cookies on the parent domain.
   */
  it('does not accept a cookie whose name only resembles the one asked for', () => {
    expect(cookieValue(`x_${STATE_COOKIE}=forged`, STATE_COOKIE)).toBeNull()
    expect(cookieValue(`${STATE_COOKIE}_x=forged`, STATE_COOKIE)).toBeNull()
  })

  /*
   * The handoff cookie carries a bearer token, and tokens are base64-ish: they
   * contain `=` as padding and `.` as separators. Splitting on `=` and keeping
   * only the second piece truncates the token, which fails as an unexplained
   * "could not sign you in" on the very last step of the flow.
   */
  it('keeps a value that contains equals signs', () => {
    const token = 'header.payload.signature=='
    expect(cookieValue(`${HANDOFF_COOKIE}=${token}`, HANDOFF_COOKIE)).toBe(token)
  })

  it('is nothing when the cookie is present but empty', () => {
    // How a browser reports a cookie we have just cleared, and it must not read
    // as a state of "".
    expect(cookieValue(`${STATE_COOKIE}=`, STATE_COOKIE)).toBeNull()
  })

  it('tolerates the spacing browsers actually send', () => {
    expect(cookieValue(`a=1;${STATE_COOKIE}=wanted;b=2`, STATE_COOKIE)).toBe('wanted')
    expect(cookieValue(`a=1;   ${STATE_COOKIE}=wanted`, STATE_COOKIE)).toBe('wanted')
  })
})

describe('the round trip these are used for', () => {
  /** The `name=value` pair out of a Set-Cookie header, as a browser would send it back. */
  const echo = (setCookie: string) => setCookie.split(';')[0]

  /*
   * The pairing that carries the whole flow.
   *
   * The state cookie holds `state|issuedAt|origin`, and `|` is percent-encoded
   * on the way out — so the value only survives because `cookieValue` decodes
   * it. If encoding and decoding ever stop agreeing, the callback splits on a
   * `|` that is no longer there, reads an empty state, and reports every
   * sign-in as expired.
   */
  it('carries state, issue time and origin back intact', () => {
    const state = 'a1b2'.repeat(16)
    const issuedAt = 1_759_000_000_000
    const sent = stateCookieHeader(STATE_COOKIE, `${state}|${issuedAt}|register`)

    const parsed = cookieValue(echo(sent), STATE_COOKIE)
    expect(parsed).toBe(`${state}|${issuedAt}|register`)

    // Split the way GoogleCallbackAction splits it.
    const [value, at, from] = (parsed ?? '').split('|')
    expect(value).toBe(state)
    expect(Number(at)).toBe(issuedAt)
    expect(from).toBe('register')
  })

  it('carries a session token back byte for byte', () => {
    // A real token shape: dots, dashes, underscores and padding.
    const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMiJ9.s-1_aB=='
    expect(cookieValue(echo(handoffCookieHeader(HANDOFF_COOKIE, token)), HANDOFF_COOKIE)).toBe(token)
  })

  it('reads a cleared state cookie as no state', () => {
    expect(cookieValue(echo(clearCookieHeader(STATE_COOKIE)), STATE_COOKIE)).toBeNull()
  })

  it('finds each cookie when both are present, as they are on the callback', () => {
    const header = [
      echo(stateCookieHeader(STATE_COOKIE, `${'f'.repeat(32)}|1759000000000|login`)),
      echo(handoffCookieHeader(HANDOFF_COOKIE, 'tok=')),
    ].join('; ')
    expect(cookieValue(header, STATE_COOKIE)).toBe(`${'f'.repeat(32)}|1759000000000|login`)
    expect(cookieValue(header, HANDOFF_COOKIE)).toBe('tok=')
  })
})

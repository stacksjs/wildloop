/**
 * "Remember me" at the API, against a real server and a throwaway database.
 *
 * The sign-in page showed the box and the form sent nothing, so every session
 * lasted thirty days whether the person asked for that or not. Wildloop signs
 * in through its own LoginAction, not the framework default, so the policy
 * has to be wired into that one — and it still has to answer with the roles
 * and profile the account menu reads.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

const ORIGIN = 'http://127.0.0.1:4320'
const HOUR = 3600
const DAY = 24 * HOUR

const account = {
  name: 'Session QA',
  email: `session-${crypto.randomUUID()}@example.test`,
  password: `Local-QA-${crypto.randomUUID()}`,
}

/** POST a JSON body with the CSRF double-submit the API asks for. */
async function post(path: string, body: unknown): Promise<Response> {
  const token = await csrfToken(API)
  return await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': ORIGIN,
      'X-CSRF-Token': token,
      'Cookie': `X-CSRF-Token=${encodeURIComponent(token)}`,
    },
    body: JSON.stringify(body),
  })
}

/**
 * The lifetime the token was really issued with. Reported from its expiry
 * against the clock, so it lands a second or so under the round number.
 */
function expectLifetime(seconds: number, expected: number): void {
  expect(seconds).toBeLessThanOrEqual(expected)
  expect(seconds).toBeGreaterThan(expected - 60)
}

async function login(remember?: unknown): Promise<any> {
  const response = await post('/login', {
    email: account.email,
    password: account.password,
    ...(remember === undefined ? {} : { remember }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json()
}

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
  const registered = await post('/register', account)
  expect(registered.status, await registered.clone().text()).toBe(200)
}, READY_TIMEOUT_MS + 30_000)

describe.skipIf(!qa)('browser sessions', () => {
  it('signs in for the working day when the box was left alone', async () => {
    const session = await login(false)
    expect(session.remembered).toBe(false)
    expectLifetime(session.expires_in, 12 * HOUR)
    expect(session.token).toBeTruthy()
  })

  it('signs in for as long as tokens last when it was ticked', async () => {
    const session = await login(true)
    expect(session.remembered).toBe(true)
    expectLifetime(session.expires_in, 30 * DAY)
  })

  it('reads the box however the form encodes it', async () => {
    for (const value of ['on', 'true', '1', 1])
      expect((await login(value)).remembered, String(value)).toBe(true)
    for (const value of ['', 'off', 'false', 0, null])
      expect((await login(value)).remembered, String(value)).toBe(false)
  })

  it('treats a client that says nothing as an ordinary session', async () => {
    const session = await login()
    expect(session.remembered).toBe(false)
    expectLifetime(session.expires_in, 12 * HOUR)
  })

  it('answers either way with the roles and profile the account menu reads', async () => {
    for (const remember of [false, true]) {
      const session = await login(remember)
      expect(session.user.email, String(remember)).toBe(account.email)
      expect(session.user.name, String(remember)).toBe(account.name)
      expect(Array.isArray(session.user.roles), String(remember)).toBe(true)
      // profileFields: the header shows a face straight after signing in.
      expect(session.user, String(remember)).toHaveProperty('avatar')
    }
  })

  it('issues a working session either way', async () => {
    for (const remember of [false, true]) {
      const { token } = await login(remember)
      const plans = await fetch(`${API}/plans`, { headers: { Authorization: `Bearer ${token}` } })
      expect(plans.status, String(remember)).toBe(200)
    }
  })

  it('revokes the token on the way out, whichever session it was', async () => {
    for (const remember of [false, true]) {
      const { token } = await login(remember)
      const headers = { Authorization: `Bearer ${token}` }
      expect((await fetch(`${API}/plans`, { headers })).status, String(remember)).toBe(200)

      const out = await fetch(`${API}/logout`, { method: 'POST', headers })
      expect(out.status, String(remember)).toBeLessThan(400)
      // Signing out has to end the session on the server too: clearing it in
      // the browser alone left the token good for its whole lifetime.
      expect((await fetch(`${API}/plans`, { headers })).status, String(remember)).toBe(401)
    }
  })

  it('still refuses the wrong password', async () => {
    const refused = await post('/login', { email: account.email, password: 'not-the-password', remember: true })
    expect(refused.status).toBe(401)
  })
})

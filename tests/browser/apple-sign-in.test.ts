/**
 * Sign in with Apple against a real server, with no Apple credentials (#970).
 *
 * The QA stack has none, and that is the state worth checking here: it is the
 * state production is in until the owner adds them, and the one the issue
 * complained about — Apple buttons on both auth pages that did nothing when
 * pressed. Unconfigured, the button must not be offered and the routes must
 * refuse plainly. The flow itself is driven end to end in
 * tests/unit/apple-callback.test.ts, against a stubbed Apple.
 *
 * One thing only a server can show: Apple's callback is a form POSTed from
 * appleid.apple.com, which carries no CSRF token. If the route were not exempt
 * from the CSRF check, the router would refuse every real Apple callback
 * before the action — and its state check — ever ran.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, APP, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
const qa = process.env.RECORDING_QA === '1'

beforeAll(async () => {
  if (qa)
    await startQaServers()
}, READY_TIMEOUT_MS + 10_000)

describe.skipIf(!qa)('Sign in with Apple, unconfigured', () => {
  it('is not offered on the sign-in or sign-up page', async () => {
    for (const path of ['/login', '/register']) {
      const html = await (await fetch(`${APP}${path}`, { headers: { accept: 'text/html' } })).text()
      expect(html, path).toContain('<form')
      expect(html, path).not.toContain('/api/auth/apple/redirect')
      // Nor the dead control it replaced: a button that looked like a way in
      // and did nothing when pressed.
      expect(html, path).not.toContain('with Apple is not available yet')
    }
  })

  it('refuses to start, rather than sending anybody to Apple', async () => {
    const response = await fetch(`${API}/auth/apple/redirect`, { redirect: 'manual' })
    expect(response.status).toBe(503)
    expect(response.headers.get('location')).toBeNull()
  })

  it('takes Apple\'s form post without a CSRF token, and says it is unavailable', async () => {
    const response = await fetch(`${API}/auth/apple/callback`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        // Where Apple's form posts from.
        'Origin': 'https://appleid.apple.com',
      },
      body: new URLSearchParams({ code: 'c', state: 's'.repeat(64) }),
    })
    expect(response.status, await response.clone().text()).toBe(303)
    expect(response.headers.get('location')).toBe('/login?error=apple-unavailable')
  })

  it('has no session to hand over', async () => {
    const response = await fetch(`${API}/auth/apple/session`, {
      method: 'POST',
      headers: { Authorization: 'Bearer none' },
    })
    // Bearer bypasses the CSRF check; without the hand-off cookie this is
    // simply an expired sign-in.
    expect(response.status, await response.clone().text()).toBe(401)
  })
})

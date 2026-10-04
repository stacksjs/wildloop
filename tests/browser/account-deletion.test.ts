/**
 * Deleting an account from inside the app (App Store 5.1.1(v)), against a
 * real server and a throwaway database.
 *
 * Two kinds of account, two kinds of proof. One registered with a password
 * types it again, as it always has. One that Google or Apple made has no
 * password it ever saw, and asking it for one made deletion impossible for
 * exactly those people, so it types DELETE from a recent sign-in instead.
 * Neither may use the other proof.
 *
 * The 15-minute rule for that second kind is in tests/unit/deletion-proof.test.ts:
 * a session here is always seconds old.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, APP, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'
import { QA_SOCIAL_ACCOUNT } from './qa-social-account'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
const qa = process.env.RECORDING_QA === '1'

const registered = {
  name: 'Deletion QA',
  email: `deletion-${crypto.randomUUID()}@example.test`,
  password: `Local-QA-${crypto.randomUUID()}`,
}

/** POST a JSON body with the CSRF double-submit the API asks for. */
async function post(path: string, body: unknown): Promise<Response> {
  const token = await csrfToken(API)
  return await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': APP,
      'X-CSRF-Token': token,
      'Cookie': `X-CSRF-Token=${encodeURIComponent(token)}`,
    },
    body: JSON.stringify(body),
  })
}

async function signIn(email: string, password: string): Promise<string> {
  const response = await post('/login', { email, password })
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()).token
}

async function me(token: string): Promise<Response> {
  return await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${token}` } })
}

async function destroy(token: string, body: Record<string, string>): Promise<Response> {
  return await fetch(`${API}/me`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
  const response = await post('/register', registered)
  expect(response.status, await response.clone().text()).toBe(200)
}, READY_TIMEOUT_MS + 30_000)

describe.skipIf(!qa)('deleting an account with a password', () => {
  it('is told it has a password, so Settings asks for it', async () => {
    const token = await signIn(registered.email, registered.password)
    const payload = await (await me(token)).json()
    expect(payload.user.hasPassword).toBe(true)
  })

  it('takes nothing but the right password', async () => {
    const token = await signIn(registered.email, registered.password)

    const nothing = await destroy(token, {})
    expect(nothing.status).toBe(422)
    // The word that stands in for a password elsewhere does not stand in here.
    expect((await destroy(token, { confirmation: 'DELETE' })).status).toBe(422)
    const wrong = await destroy(token, { password: 'not-the-password' })
    expect(wrong.status).toBe(403)
    expect((await wrong.json()).error).toBe('That is not your password.')
    expect((await me(token)).status).toBe(200)

    const deleted = await destroy(token, { password: registered.password })
    expect(deleted.status, await deleted.clone().text()).toBe(204)
    expect((await me(token)).status).toBe(401)
    expect((await post('/login', { email: registered.email, password: registered.password })).status).toBe(401)
  })
})

describe.skipIf(!qa)('deleting an account Google made', () => {
  it('is told it has no password, so Settings asks for DELETE instead', async () => {
    const token = await signIn(QA_SOCIAL_ACCOUNT.email, QA_SOCIAL_ACCOUNT.sessionSecret)
    const payload = await (await me(token)).json()
    expect(payload.user.hasPassword).toBe(false)
  })

  it('confirms with DELETE from a fresh sign-in, and a password is no substitute', async () => {
    const token = await signIn(QA_SOCIAL_ACCOUNT.email, QA_SOCIAL_ACCOUNT.sessionSecret)

    const withPassword = await destroy(token, { password: QA_SOCIAL_ACCOUNT.sessionSecret })
    expect(withPassword.status).toBe(422)
    expect((await withPassword.json()).error).toBe('Type DELETE to confirm.')
    expect((await destroy(token, { confirmation: 'yes' })).status).toBe(422)
    expect((await me(token)).status).toBe(200)

    const deleted = await destroy(token, { confirmation: 'DELETE' })
    expect(deleted.status, await deleted.clone().text()).toBe(204)
    expect((await me(token)).status).toBe(401)
  })
})

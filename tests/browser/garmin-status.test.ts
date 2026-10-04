/**
 * The Garmin card on the settings screen reads `GET /api/garmin/status`, and
 * its buttons post to `/api/garmin/disconnect` and `/api/garmin/connect`.
 *
 * Two things here are easy to get wrong and invisible until someone clicks.
 *
 * The first is that "not set up yet" and "not connected" are different
 * answers. Garmin has not approved the app for their Activity API, so every
 * local, QA and CI run is unconfigured, and the card has to say so rather than
 * offering a button that fails. `/connect` answers 503 with an explanation for
 * exactly that reason.
 *
 * The second is that the status payload must never carry Garmin tokens. It is
 * read by a browser, so anything in it has a wider blast radius than it looks.
 * `garmin_user_id` is selected by the query and deliberately not serialised.
 *
 * Not covered here: the connected path. It needs a real `garmin_connections`
 * row, which needs credentials QA does not have, so `connected: true`,
 * `lastSyncAt` and `importedCount` are only reachable once the integration is
 * configured. `tests/browser/garmin-settings.pw.ts` renders those states from
 * mocked responses; this file is about what the real endpoints answer.
 *
 * Nothing exercised `/garmin/disconnect` at all before this.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, APP, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

const ORIGIN = APP

const account = {
  name: 'Garmin Status QA',
  email: `garmin-status-${crypto.randomUUID()}@example.test`,
  password: `Local-QA-${crypto.randomUUID()}`,
}

/** Send a JSON body with the CSRF double-submit the API asks for. */
async function send(path: string, method: string, body?: unknown, token?: string): Promise<Response> {
  const csrf = await csrfToken(API)
  return await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Origin': ORIGIN,
      'X-CSRF-Token': csrf,
      'Cookie': `X-CSRF-Token=${encodeURIComponent(csrf)}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const authed = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } })

let bearer = ''

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()

  const registered = await send('/register', 'POST', account)
  expect(registered.status, await registered.clone().text()).toBe(200)

  const loggedIn = await send('/login', 'POST', { email: account.email, password: account.password })
  expect(loggedIn.status, await loggedIn.clone().text()).toBe(200)
  bearer = (await loggedIn.json()).token
}, READY_TIMEOUT_MS + 30_000)

describe.skipIf(!qa)('garmin status', () => {
  it('reports availability and connection separately', async () => {
    const response = await fetch(`${API}/garmin/status`, authed(bearer))
    expect(response.status, await response.clone().text()).toBe(200)
    const payload = await response.json()

    expect(payload.success).toBe(true)
    // Both are answers about different things: whether the integration exists
    // on this deployment, and whether this athlete has joined it.
    expect(typeof payload.configured).toBe('boolean')
    expect(payload.connected).toBe(false)
  })

  it('never hands the browser a Garmin credential', async () => {
    const response = await fetch(`${API}/garmin/status`, authed(bearer))
    const body = await response.text()

    // Checked against the serialised body rather than named keys, so a token
    // nested under a future field cannot slip through.
    expect(body).not.toMatch(/token|secret|refresh/i)
    // The athlete's Garmin identifier is read by the query and must stay server-side.
    expect(body).not.toContain('garmin_user_id')
  })

  it('refuses to report status without a session', async () => {
    const response = await fetch(`${API}/garmin/status`)
    expect(response.status).toBe(401)
    expect((await response.json()).message).toContain('Authorization: Bearer')
  })

  it('explains that syncing is unavailable rather than failing on click', async () => {
    const response = await fetch(`${API}/garmin/connect`, authed(bearer))

    // 503, not 404 or 500: the integration is understood and deliberately off
    // until Garmin approves the app, and the card shows this sentence.
    expect(response.status, await response.clone().text()).toBe(503)
    const payload = await response.json()
    expect(payload.success).toBe(false)
    expect(payload.error).toContain('not available yet')
  })

  it('refuses to start a connection without a session', async () => {
    const response = await fetch(`${API}/garmin/connect`)
    expect(response.status).toBe(401)
    expect((await response.json()).message).toContain('Authorization: Bearer')
  })

  it('disconnects an athlete who was never connected, and says so', async () => {
    // Idempotent on purpose: the settings screen can post this without first
    // reading status, and a stale card cannot produce an error.
    const first = await send('/garmin/disconnect', 'POST', {}, bearer)
    expect(first.status, await first.clone().text()).toBe(200)
    expect(await first.json()).toMatchObject({ success: true, disconnected: true })

    const second = await send('/garmin/disconnect', 'POST', {}, bearer)
    expect(second.status).toBe(200)
    expect(await second.json()).toMatchObject({ success: true, disconnected: true })
  })

  it('leaves the athlete unconnected after disconnecting', async () => {
    const response = await fetch(`${API}/garmin/status`, authed(bearer))
    expect((await response.json()).connected).toBe(false)
  })

  it('refuses to disconnect without a session', async () => {
    const response = await send('/garmin/disconnect', 'POST', {})
    // The auth middleware runs before CSRF, so this is 401 rather than 403.
    expect(response.status).toBe(401)
    expect((await response.json()).message).toContain('Authorization: Bearer')
  })
})

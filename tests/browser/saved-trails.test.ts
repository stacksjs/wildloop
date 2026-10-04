/**
 * A profile's Saved tab reads straight from `GET /users/{id}/saved-trails`.
 *
 * The rule that is easy to get wrong: one row carries both "saved" and "done",
 * so marking a trail done writes a row that must NOT appear under Saved. The
 * action filters on `is_saved`, and nothing covered that — a regression there
 * shows up as somebody else's trails appearing in their hearts, which no unit
 * test of the surrounding code would catch.
 *
 * The existing avatar/garmin/completed-trail unit tests are pure-function
 * tests and never make a request, so this is the first HTTP-level coverage of
 * the endpoint.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, APP, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

const ORIGIN = APP

const account = {
  name: 'Saved Trails QA',
  email: `saved-trails-${crypto.randomUUID()}@example.test`,
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

async function savedTrails(userId: number): Promise<any> {
  const response = await fetch(`${API}/users/${userId}/saved-trails`)
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json()
}

let userId = 0
let bearer = ''
let savedTrailId = 0
let doneTrailId = 0

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()

  const registered = await send('/register', 'POST', account)
  expect(registered.status, await registered.clone().text()).toBe(200)

  const loggedIn = await send('/login', 'POST', { email: account.email, password: account.password })
  expect(loggedIn.status, await loggedIn.clone().text()).toBe(200)
  const session = await loggedIn.json()
  bearer = session.token
  userId = session.user.id

  // Two different trails from the QA catalog: one hearted, one only walked.
  const catalog = await (await fetch(`${API}/trails?limit=3`)).json()
  expect(catalog.trails.length).toBeGreaterThanOrEqual(2)
  savedTrailId = catalog.trails[0].id
  doneTrailId = catalog.trails[1].id

  const saved = await send(`/trails/${savedTrailId}/save`, 'PUT', {}, bearer)
  expect(saved.status, await saved.clone().text()).toBe(200)

  const done = await send(`/trails/${doneTrailId}/done`, 'PUT', {}, bearer)
  expect(done.status, await done.clone().text()).toBe(200)
}, READY_TIMEOUT_MS + 30_000)

describe.skipIf(!qa)('saved trails', () => {
  it('lists a hearted trail with its summary joined in', async () => {
    const payload = await savedTrails(userId)

    expect(payload.success).toBe(true)
    const entry = payload.savedTrails.find((s: any) => s.trailId === savedTrailId)
    expect(entry).toBeTruthy()
    // The Saved tab renders from this directly, so the trail summary has to
    // come back with it rather than needing a second request per row.
    expect(entry.trail).toMatchObject({ id: savedTrailId })
    expect(typeof entry.trail.name).toBe('string')
    expect(entry.trail.name.length).toBeGreaterThan(0)
    expect(entry.savedAt).toBeTruthy()
  })

  it('leaves out a trail that was marked done but never saved', async () => {
    const payload = await savedTrails(userId)

    // Marking a trail done writes the same row type. Only the hearts belong
    // here, so the done-only trail must be absent.
    expect(payload.savedTrails.map((s: any) => s.trailId)).not.toContain(doneTrailId)
    expect(payload.savedTrails.map((s: any) => s.trailId)).toContain(savedTrailId)
  })

  it('stops listing a trail once it is unsaved', async () => {
    const removed = await send(`/trails/${savedTrailId}/save`, 'DELETE', undefined, bearer)
    expect(removed.status, await removed.clone().text()).toBe(200)

    const payload = await savedTrails(userId)
    expect(payload.savedTrails.map((s: any) => s.trailId)).not.toContain(savedTrailId)

    // Put it back so the ordering of these tests does not matter.
    const restored = await send(`/trails/${savedTrailId}/save`, 'PUT', {}, bearer)
    expect(restored.status).toBe(200)
  })

  it('reads publicly, without a session', async () => {
    // The profile's Saved tab is public, like follows and achievements.
    const response = await fetch(`${API}/users/${userId}/saved-trails`)
    expect(response.status).toBe(200)
    expect((await response.json()).success).toBe(true)
  })

  it('answers with an empty list for a user who has saved nothing', async () => {
    const payload = await savedTrails(999_999)

    expect(payload.savedTrails).toEqual([])
    expect(payload.meta).toMatchObject({ total: 0, hasMore: false })
  })

  it('rejects an id that is not a positive integer', async () => {
    for (const id of ['0', 'abc', '-1']) {
      const response = await fetch(`${API}/users/${id}/saved-trails`)
      expect(response.status, `id ${id}`).toBe(422)

      const payload = await response.json()
      expect(payload.success).toBe(false)
      expect(payload.fields).toMatchObject({ user_id: expect.stringContaining('positive integer') })
    }
  })
})

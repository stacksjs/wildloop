/**
 * The profile's Completed tab reads `GET /me/completed-trails`.
 *
 * It is the mirror of the rule `saved-trails.test.ts` guards. One row in
 * `saved_trails` carries both "saved" and "done", so the two endpoints filter
 * the same table in opposite directions: Saved wants `is_saved`, Completed
 * wants `has_visited`. Getting either backwards shows somebody the wrong list,
 * and no unit test of the surrounding code would catch it.
 *
 * Unlike the public saved list, this one is behind auth and scoped to the
 * caller: activities can be private, so which trails someone walked is not a
 * public read.
 *
 * `tests/unit/completed-trails.test.ts` covers `summariseCompletions` as a
 * pure function and never makes a request, so this is the first HTTP-level
 * coverage of the endpoint.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

const ORIGIN = 'http://127.0.0.1:4320'

const account = {
  name: 'Completed Trails QA',
  email: `completed-trails-${crypto.randomUUID()}@example.test`,
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

async function completed(token: string): Promise<any> {
  const response = await fetch(`${API}/me/completed-trails`, { headers: { Authorization: `Bearer ${token}` } })
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json()
}

const listedIds = (payload: any): number[] => (payload.completedTrails ?? []).map((entry: any) => entry.trailId)

let bearer = ''
let doneTrailId = 0
let savedOnlyTrailId = 0

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()

  const registered = await send('/register', 'POST', account)
  expect(registered.status, await registered.clone().text()).toBe(200)

  const loggedIn = await send('/login', 'POST', { email: account.email, password: account.password })
  expect(loggedIn.status, await loggedIn.clone().text()).toBe(200)
  bearer = (await loggedIn.json()).token

  // Two different trails from the QA catalog: one marked done, one only
  // hearted. The second is the one that must not appear below.
  const catalog = await (await fetch(`${API}/trails?limit=3`)).json()
  expect(catalog.trails.length).toBeGreaterThanOrEqual(2)
  doneTrailId = catalog.trails[0].id
  savedOnlyTrailId = catalog.trails[1].id

  const done = await send(`/trails/${doneTrailId}/done`, 'PUT', {}, bearer)
  expect(done.status, await done.clone().text()).toBe(200)

  const saved = await send(`/trails/${savedOnlyTrailId}/save`, 'PUT', {}, bearer)
  expect(saved.status, await saved.clone().text()).toBe(200)
}, READY_TIMEOUT_MS + 30_000)

describe.skipIf(!qa)('completed trails', () => {
  it('lists a trail marked done, with its summary joined in', async () => {
    const payload = await completed(bearer)

    expect(payload.success).toBe(true)
    const entry = payload.completedTrails.find((c: any) => c.trailId === doneTrailId)
    expect(entry).toBeTruthy()
    // The tab renders from this directly, so the trail summary has to come
    // back with it rather than needing a second request per row.
    expect(entry.trail).toMatchObject({ id: doneTrailId })
    expect(typeof entry.trail.name).toBe('string')
    expect(entry.trail.name.length).toBeGreaterThan(0)
    expect(entry.lastCompletedAt).toBeTruthy()
  })

  it('counts no walks for a trail that was only marked done', async () => {
    const payload = await completed(bearer)
    const entry = payload.completedTrails.find((c: any) => c.trailId === doneTrailId)

    // `times` counts recorded activities on the trail, not done-marks. Saying
    // "I walked this before Wildloop" is not a recorded walk, so it stays 0 —
    // making this increment would overcount every manual mark as a walk.
    expect(entry.times).toBe(0)
  })

  it('leaves out a trail that was saved but never marked done', async () => {
    const payload = await completed(bearer)

    // The same row type backs both lists. Only the done ones belong here.
    expect(listedIds(payload)).not.toContain(savedOnlyTrailId)
    expect(listedIds(payload)).toContain(doneTrailId)
  })

  it('stops listing a trail once it is un-marked', async () => {
    const removed = await send(`/trails/${doneTrailId}/done`, 'DELETE', undefined, bearer)
    expect(removed.status, await removed.clone().text()).toBe(200)

    expect(listedIds(await completed(bearer))).not.toContain(doneTrailId)

    // Put it back so the ordering of these tests does not matter.
    const restored = await send(`/trails/${doneTrailId}/done`, 'PUT', {}, bearer)
    expect(restored.status).toBe(200)
    expect(listedIds(await completed(bearer))).toContain(doneTrailId)
  })

  it('refuses to read without a session', async () => {
    // Unlike the saved list, this one is private: it exposes activities.
    const response = await fetch(`${API}/me/completed-trails`)
    expect(response.status).toBe(401)
    expect((await response.json()).message).toContain('Authorization: Bearer')
  })

  it('shows one athlete nothing of another athlete\'s walks', async () => {
    const other = {
      name: 'Completed Trails QA Other',
      email: `completed-trails-other-${crypto.randomUUID()}@example.test`,
      password: `Local-QA-${crypto.randomUUID()}`,
    }
    expect((await send('/register', 'POST', other)).status).toBe(200)
    const session = await (await send('/login', 'POST', { email: other.email, password: other.password })).json()

    // A fresh athlete has walked nothing, and must not inherit the list above.
    const payload = await completed(session.token)
    expect(payload.completedTrails).toEqual([])
  })
})

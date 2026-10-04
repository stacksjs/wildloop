/**
 * Asking for a region of the trail catalog to be ingested again (#976),
 * against a real server and a throwaway database.
 *
 * The unit suite proves what gets queued. This one proves the parts only a
 * server can: that the route is closed to anybody who is not an admin, that it
 * answers at once with what it queued rather than holding the request open
 * for a fetch, and that asking twice leaves the queue exactly as one ask did.
 *
 * Nothing here reaches Overpass. The QA stack runs no ingest worker, so the
 * queued shards simply wait in the QA database until it is thrown away.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { QA_ADMIN } from './qa-admin'
import { API, APP, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
const qa = process.env.RECORDING_QA === '1'

const ENDPOINT = `${API}/maintenance/reingest-region`

const stranger = {
  name: 'Reingest QA',
  email: `reingest-${crypto.randomUUID()}@example.test`,
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

function reingest(token: string | null, body: Record<string, unknown>): Promise<Response> {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
}

let strangerToken = ''
let adminToken = ''

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
  const registered = await post('/register', stranger)
  expect(registered.status, await registered.clone().text()).toBe(200)
  strangerToken = await signIn(stranger.email, stranger.password)
  adminToken = await signIn(QA_ADMIN.email, QA_ADMIN.password)
}, READY_TIMEOUT_MS + 30_000)

describe.skipIf(!qa)('re-ingesting a region', () => {
  it('is refused to somebody who is not signed in', async () => {
    const response = await reingest(null, { region: 'CO' })
    // 401 from the auth guard, or 403 from the CSRF check in front of it for
    // a cookie-less POST. Either way, nothing is queued.
    expect([401, 403], await response.clone().text()).toContain(response.status)
  })

  it('is refused to a signed-in athlete who is not an admin', async () => {
    const response = await reingest(strangerToken, { region: 'CO' })
    expect(response.status, await response.clone().text()).toBe(403)
  })

  /*
   * The acceptance line: asking twice for the same region does not double the
   * shards. The first ask accounts for every tile, as queued or (on a stack
   * reused from an earlier run) as already queued; the second finds them all
   * waiting and queues none.
   */
  it('queues a region once, however many times it is asked', async () => {
    const started = Date.now()
    const first = await reingest(adminToken, { region: 'co' })
    const elapsed = Date.now() - started
    expect(first.status, await first.clone().text()).toBe(202)
    const queued = await first.json()

    expect(queued.region).toEqual({ country: 'US', code: 'CO', name: 'Colorado' })
    expect(queued.source).toBe('osm')
    expect(queued.tiles).toBe(28)
    expect(queued.queued + queued.alreadyQueued).toBe(28)
    // It queued and returned. A single Overpass tile takes minutes.
    expect(elapsed).toBeLessThan(10_000)

    const again = await reingest(adminToken, { region: 'CO' })
    expect(again.status, await again.clone().text()).toBe(202)
    const second = await again.json()
    expect(second.queued).toBe(0)
    expect(second.alreadyQueued).toBe(28)
  })

  it('refuses a region the catalog does not cover', async () => {
    // The guard against aiming the Overpass budget at somewhere arbitrary.
    const response = await reingest(adminToken, { region: 'FR-IDF' })
    expect(response.status, await response.clone().text()).toBe(422)
    expect((await response.json()).fields.region).toContain('not a region')
  })
})

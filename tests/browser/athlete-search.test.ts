/**
 * The athlete directory, through `GET /api/users/search`.
 *
 * It counts, orders and pages in SQL now, rather than loading every user and
 * every activity they ever recorded. What must not change is the order (near
 * the asker first, then most active, most followed, oldest account), the
 * counts on each card, who a block hides, and `meta`.
 *
 * Four athletes share a token in their names so a search finds exactly them
 * in a database other suites are writing to. Alpha has two runs, Bravo one;
 * Charlie has none but Alpha follows them, and lives in Denver; Delta has
 * neither, and has blocked Alpha.
 *
 * `tests/unit/athlete-search.test.ts` checks the same SQL against the old
 * in-memory code on mixed data; this is the request the app makes.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, APP, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

const DAY = 24 * 60 * 60 * 1000
const TOKEN = crypto.randomUUID().slice(0, 8)
/** Denver, which the QA gazetteer knows. */
const DENVER = 'lat=39.74&lng=-104.98'

/** Send a JSON body with the CSRF double-submit the API asks for. */
async function send(path: string, method: string, body?: unknown, token?: string): Promise<Response> {
  const csrf = await csrfToken(API)
  return await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Origin': APP,
      'X-CSRF-Token': csrf,
      'Cookie': `X-CSRF-Token=${encodeURIComponent(csrf)}`,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

/** Register and sign in a fresh athlete. */
async function athlete(role: string): Promise<{ id: number, token: string }> {
  const account = {
    name: `Search QA ${TOKEN} ${role}`,
    email: `search-${role.toLowerCase()}-${crypto.randomUUID()}@example.test`,
    password: `Local-QA-${crypto.randomUUID()}`,
  }
  const registered = await send('/register', 'POST', account)
  expect(registered.status, await registered.clone().text()).toBe(200)
  const loggedIn = await send('/login', 'POST', { email: account.email, password: account.password })
  expect(loggedIn.status, await loggedIn.clone().text()).toBe(200)
  const session = await loggedIn.json()
  return { id: Number(session.user.id), token: session.token }
}

async function search(query: string, token?: string): Promise<any> {
  const response = await fetch(`${API}/users/search?${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  expect(response.status, await response.clone().text()).toBe(200)
  const payload = await response.json()
  expect(payload.success).toBe(true)
  return payload
}

const roles = (payload: any): string[] => payload.athletes.map((a: any) => String(a.name).split(' ').pop())

let alpha = { id: 0, token: '' }
let bravo = { id: 0, token: '' }
let charlie = { id: 0, token: '' }
let delta = { id: 0, token: '' }

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()

  alpha = await athlete('Alpha')
  bravo = await athlete('Bravo')
  charlie = await athlete('Charlie')
  delta = await athlete('Delta')

  const now = Date.now()
  const runs: Array<[{ token: string }, number]> = [[alpha, 1], [alpha, 2], [bravo, 1]]
  for (const [who, daysAgo] of runs) {
    const stored = await send('/activities', 'POST', {
      activity_type: 'Trail Run',
      duration: '30:00',
      distance: 3,
      recording_source: 'manual',
      visibility: 'private',
      completed_at: new Date(now - daysAgo * DAY).toISOString(),
    }, who.token)
    expect(stored.status, await stored.clone().text()).toBe(201)
  }

  const follow = await send(`/users/${charlie.id}/follow`, 'PUT', {}, alpha.token)
  expect(follow.status, await follow.clone().text()).toBe(200)
  const block = await send(`/users/${alpha.id}/block`, 'POST', {}, delta.token)
  expect(block.status, await block.clone().text()).toBe(200)
  const profile = await send('/me/profile', 'PUT', { name: `Search QA ${TOKEN} Charlie`, location: 'Denver, CO' }, charlie.token)
  expect(profile.status, await profile.clone().text()).toBe(200)
}, READY_TIMEOUT_MS + 60_000)

describe.skipIf(!qa)('athlete search', () => {
  it('finds the athletes by name, most active first, with their numbers', async () => {
    const payload = await search(`q=${TOKEN}`)

    expect(roles(payload)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta'])
    expect(payload.athletes[0]).toEqual({
      id: alpha.id,
      name: `Search QA ${TOKEN} Alpha`,
      avatar: null,
      nearYou: false,
      // Private runs count: the card says how much somebody runs, not what.
      activityCount: 2,
      followerCount: 0,
      territoriesOwned: 0,
      totalAreaOwned: 0,
    })
    expect(payload.athletes[2]).toMatchObject({ id: charlie.id, activityCount: 0, followerCount: 1 })
    expect(payload.meta).toEqual({ offset: 0, limit: 20, total: 4, hasMore: false, query: TOKEN })
  })

  it('ignores case', async () => {
    expect(roles(await search(`q=${TOKEN.toUpperCase()}`))).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta'])
  })

  it('pages, and counts every match in meta', async () => {
    const payload = await search(`q=${TOKEN}&limit=2&offset=1`)

    expect(roles(payload)).toEqual(['Bravo', 'Charlie'])
    expect(payload.meta).toEqual({ offset: 1, limit: 2, total: 4, hasMore: true, query: TOKEN })
  })

  it('hides a block from both sides', async () => {
    const forDelta = await search(`q=${TOKEN}`, delta.token)
    expect(roles(forDelta)).toEqual(['Bravo', 'Charlie', 'Delta'])
    expect(forDelta.meta.total).toBe(3)

    expect(roles(await search(`q=${TOKEN}`, alpha.token))).toEqual(['Alpha', 'Bravo', 'Charlie'])
  })

  it('puts athletes near the asker first in the discover list', async () => {
    const payload = await search(`${DENVER}&limit=50`)
    const at = payload.athletes.findIndex((a: any) => a.id === charlie.id)

    expect(at).toBeGreaterThanOrEqual(0)
    expect(payload.athletes[at].nearYou).toBe(true)
    expect(payload.athletes.slice(0, at).every((a: any) => a.nearYou)).toBe(true)
    expect(payload.athletes.find((a: any) => a.id === alpha.id)?.nearYou ?? false).toBe(false)
    expect(payload.meta).toMatchObject({ offset: 0, limit: 50, query: '' })
  })

  it('says nothing about place in a name search', async () => {
    const payload = await search(`q=${TOKEN}&${DENVER}`)

    expect(roles(payload)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta'])
    expect(payload.athletes.every((a: any) => a.nearYou === false)).toBe(true)
  })
})

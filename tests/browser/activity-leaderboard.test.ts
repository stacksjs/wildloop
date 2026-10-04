/**
 * The activity leaderboard, through `GET /api/activities/leaderboard`.
 *
 * It sums per athlete in SQL now, from an index, rather than loading every
 * activity in the period. What must not change is who counts for whom: the
 * public boards count public runs only, the following board adds
 * followers-only runs and the viewer's own private ones, and a block hides
 * an athlete either way round.
 *
 * Runner lives in Denver and records five runs; one is stamped with a UTC
 * offset rather than by `toISOString()`, which the endpoint judges apart from
 * the rest, and one is three weeks old. Climber records one big climb and has
 * no profile town. Fan follows Runner. Other suites write public runs to the
 * same database, so the public boards are checked by these athletes' rows;
 * the following board is the viewer's own and is checked whole.
 *
 * `tests/unit/activity-leaderboard.test.ts` checks the same SQL against the
 * old in-memory code on mixed data; this is the request the app makes.
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
    name: `Board QA ${TOKEN} ${role}`,
    email: `board-${role.toLowerCase()}-${crypto.randomUUID()}@example.test`,
    password: `Local-QA-${crypto.randomUUID()}`,
  }
  const registered = await send('/register', 'POST', account)
  expect(registered.status, await registered.clone().text()).toBe(200)
  const loggedIn = await send('/login', 'POST', { email: account.email, password: account.password })
  expect(loggedIn.status, await loggedIn.clone().text()).toBe(200)
  const session = await loggedIn.json()
  return { id: Number(session.user.id), token: session.token }
}

async function board(query: string, token?: string): Promise<any> {
  const response = await fetch(`${API}/activities/leaderboard?${query}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  expect(response.status, await response.clone().text()).toBe(200)
  const payload = await response.json()
  expect(payload.success).toBe(true)
  return payload
}

const rowOf = (payload: any, who: { id: number }): any => payload.leaderboard.find((row: any) => row.userId === who.id)

/** The same instant written with a UTC offset, as a hand-made API call might. */
function withOffset(ms: number, minutes: number): string {
  const local = new Date(ms + minutes * 60_000).toISOString().slice(0, 23)
  return `${local}+${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

let runner = { id: 0, token: '' }
let climber = { id: 0, token: '' }
let fan = { id: 0, token: '' }

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()

  runner = await athlete('Runner')
  climber = await athlete('Climber')
  fan = await athlete('Fan')

  const now = Date.now()
  const runs: Array<[{ token: string }, Record<string, unknown>]> = [
    [runner, { distance: 10.5, elevation: 100, visibility: 'public', completed_at: new Date(now - 1 * DAY).toISOString() }],
    [runner, { distance: 2, elevation: 0, visibility: 'followers', completed_at: new Date(now - 2 * DAY).toISOString() }],
    [runner, { distance: 4, elevation: 0, visibility: 'private', completed_at: new Date(now - 3 * DAY).toISOString() }],
    [runner, { distance: 1.25, elevation: 50, visibility: 'public', completed_at: withOffset(now - 2.5 * DAY, 120) }],
    [runner, { distance: 20, elevation: 0, visibility: 'public', completed_at: new Date(now - 20 * DAY).toISOString() }],
    [climber, { distance: 3, elevation: 900, visibility: 'public', completed_at: new Date(now - 1 * DAY).toISOString() }],
  ]
  for (const [who, run] of runs) {
    const stored = await send('/activities', 'POST', { activity_type: 'Trail Run', duration: '2:00:00', recording_source: 'manual', ...run }, who.token)
    expect(stored.status, await stored.clone().text()).toBe(201)
  }

  const follow = await send(`/users/${runner.id}/follow`, 'PUT', {}, fan.token)
  expect(follow.status, await follow.clone().text()).toBe(200)
  const profile = await send('/me/profile', 'PUT', { name: `Board QA ${TOKEN} Runner`, location: 'Denver, CO' }, runner.token)
  expect(profile.status, await profile.clone().text()).toBe(200)
}, READY_TIMEOUT_MS + 60_000)

describe.skipIf(!qa)('activity leaderboard', () => {
  it('sums this week\'s public runs, odd stamps included', async () => {
    const payload = await board('period=weekly&metric=distance')

    expect(payload).toMatchObject({ period: 'weekly', metric: 'distance', scope: 'global' })
    expect(rowOf(payload, runner)).toMatchObject({
      userName: `Board QA ${TOKEN} Runner`,
      userAvatar: null,
      totalDistance: 11.75,
      totalElevation: 150,
      trailsCompleted: 2,
    })
    expect(rowOf(payload, climber)).toMatchObject({ totalDistance: 3, totalElevation: 900, trailsCompleted: 1 })
    expect(rowOf(payload, fan)).toBeUndefined()
    expect(rowOf(payload, runner).rank).toBeLessThan(rowOf(payload, climber).rank)
    expect(payload.leaderboard.map((row: any) => row.rank)).toEqual(payload.leaderboard.map((_: any, i: number) => i + 1))
  })

  it('ranks by the metric asked for', async () => {
    const payload = await board('period=weekly&metric=elevation')

    expect(rowOf(payload, climber).rank).toBeLessThan(rowOf(payload, runner).rank)
    const values = payload.leaderboard.map((row: any) => row.totalElevation)
    expect(values).toEqual([...values].sort((a: number, b: number) => b - a))
  })

  it('takes a month when asked', async () => {
    expect(rowOf(await board('period=monthly'), runner)).toMatchObject({ totalDistance: 31.75, trailsCompleted: 3 })
  })

  it('shows a follower the followers-only run, and nobody else\'s board', async () => {
    const payload = await board('period=weekly&scope=following', fan.token)

    expect(payload.scope).toBe('following')
    expect(payload.leaderboard).toEqual([{
      rank: 1,
      userId: runner.id,
      userName: `Board QA ${TOKEN} Runner`,
      userAvatar: null,
      totalDistance: 13.75,
      totalElevation: 150,
      trailsCompleted: 3,
    }])
  })

  it('shows the runner their own private run too', async () => {
    expect((await board('period=weekly&scope=following', runner.token)).leaderboard)
      .toMatchObject([{ rank: 1, userId: runner.id, totalDistance: 17.75, trailsCompleted: 4 }])
  })

  it('has no following board for someone signed out', async () => {
    expect(await board('scope=following')).toMatchObject({ scope: 'following', leaderboard: [] })
  })

  it('counts only athletes whose town is near the place asked about', async () => {
    const payload = await board(`period=weekly&scope=local&${DENVER}`)

    expect(payload.scope).toBe('local')
    expect(rowOf(payload, runner)).toMatchObject({ totalDistance: 11.75, trailsCompleted: 2 })
    expect(rowOf(payload, climber)).toBeUndefined()
    expect((await board('period=weekly&scope=local')).scope).toBe('global')
  })

  it('hides a block from both sides', async () => {
    const block = await send(`/users/${runner.id}/block`, 'POST', {}, climber.token)
    expect(block.status, await block.clone().text()).toBe(200)

    const forClimber = await board('period=weekly', climber.token)
    expect(rowOf(forClimber, runner)).toBeUndefined()
    expect(rowOf(forClimber, climber)).toBeDefined()
    expect(rowOf(await board('period=weekly', runner.token), climber)).toBeUndefined()
  })
})

/**
 * The clubs list's this-week numbers, through `GET /api/clubs`.
 *
 * `weeklyDistance` and `activitiesThisWeek` are counted in SQL now, joined to
 * `club_members` and windowed to the last seven days, rather than by loading
 * every activity ever recorded. What must not change is whose mileage counts
 * for whom (#957): a member's private run never reaches a club's numbers for
 * anyone else, and followers-only runs count only for followers.
 *
 * One runner owns the club and records six activities whose distances are
 * powers of two, so each total names exactly the runs that went into it. Two
 * of them carry a `completed_at` in a shape other than `toISOString()`, which
 * the endpoint judges separately, so that path is exercised too.
 *
 * `tests/unit/club-weekly-stats.test.ts` checks the same SQL against the old
 * in-memory count on mixed data; this is the request a browser makes.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

const ORIGIN = 'http://127.0.0.1:4320'
const DAY = 24 * 60 * 60 * 1000
const CLUB_NAME = `Weekly Stats QA ${crypto.randomUUID().slice(0, 8)}`

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

/** Register and sign in a fresh athlete. */
async function athlete(role: string): Promise<{ id: number, token: string }> {
  const account = {
    name: `Club Week ${role}`,
    email: `club-week-${role}-${crypto.randomUUID()}@example.test`,
    password: `Local-QA-${crypto.randomUUID()}`,
  }
  const registered = await send('/register', 'POST', account)
  expect(registered.status, await registered.clone().text()).toBe(200)
  const loggedIn = await send('/login', 'POST', { email: account.email, password: account.password })
  expect(loggedIn.status, await loggedIn.clone().text()).toBe(200)
  const session = await loggedIn.json()
  return { id: Number(session.user.id), token: session.token }
}

/** This test's club as the list shows it to `token`'s owner, or signed out. */
async function listed(token?: string): Promise<any> {
  const response = await fetch(`${API}/clubs?q=${encodeURIComponent(CLUB_NAME)}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  expect(response.status, await response.clone().text()).toBe(200)
  const payload = await response.json()
  expect(payload.success).toBe(true)
  expect(payload.clubs).toHaveLength(1)
  return payload.clubs[0]
}

/** The same instant written with a UTC offset, as a hand-made API call might. */
function withOffset(ms: number, minutes: number): string {
  const local = new Date(ms + minutes * 60_000).toISOString().slice(0, 23)
  return `${local}+${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
}

let runner = { id: 0, token: '' }
let fan = { id: 0, token: '' }
let stranger = { id: 0, token: '' }

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()

  runner = await athlete('runner')
  fan = await athlete('fan')
  stranger = await athlete('stranger')

  const club = await send('/clubs', 'POST', { name: CLUB_NAME, club_type: 'Running', location: 'Denver, CO' }, runner.token)
  expect(club.status, await club.clone().text()).toBe(201)

  const follow = await send(`/users/${runner.id}/follow`, 'PUT', {}, fan.token)
  expect(follow.status, await follow.clone().text()).toBe(200)

  // Hours apart, so none of them overlaps another in the history checks.
  const now = Date.now()
  const runs = [
    { distance: 1, visibility: 'public', completed_at: new Date(now - 1 * DAY).toISOString() },
    { distance: 2, visibility: 'followers', completed_at: new Date(now - 2 * DAY).toISOString() },
    { distance: 4, visibility: 'private', completed_at: new Date(now - 3 * DAY).toISOString() },
    // A week and more ago: outside the window for everyone.
    { distance: 8, visibility: 'public', completed_at: new Date(now - 9 * DAY).toISOString() },
    { distance: 16, visibility: 'public', completed_at: withOffset(now - 2.5 * DAY, 120) },
    { distance: 32, visibility: 'followers', completed_at: new Date(now - 4 * DAY).toUTCString() },
  ]
  for (const run of runs) {
    const stored = await send('/activities', 'POST', {
      activity_type: 'Trail Run',
      duration: '30:00',
      recording_source: 'manual',
      ...run,
    }, runner.token)
    expect(stored.status, await stored.clone().text()).toBe(201)
  }
}, READY_TIMEOUT_MS + 60_000)

describe.skipIf(!qa)('club weekly stats', () => {
  it('counts only public runs from this week for someone signed out', async () => {
    const club = await listed()

    expect(club).toMatchObject({ name: CLUB_NAME, memberCount: 1, isMember: false, weeklyDistance: 1 + 16, activitiesThisWeek: 2 })
    // The rest of the row is what it always was.
    expect(club.lat).toEqual(expect.any(Number))
    expect(club.lng).toEqual(expect.any(Number))
    expect(club.members).toBeUndefined()
  })

  it('counts the same for a signed-in athlete who does not follow the runner', async () => {
    expect(await listed(stranger.token)).toMatchObject({ isMember: false, weeklyDistance: 17, activitiesThisWeek: 2 })
  })

  it('adds followers-only runs for a follower, but never the private one', async () => {
    expect(await listed(fan.token)).toMatchObject({ isMember: false, weeklyDistance: 1 + 2 + 16 + 32, activitiesThisWeek: 4 })
  })

  it('shows the runner their own private run too', async () => {
    expect(await listed(runner.token)).toMatchObject({ memberCount: 1, isMember: true, weeklyDistance: 1 + 2 + 4 + 16 + 32, activitiesThisWeek: 5 })
  })
})

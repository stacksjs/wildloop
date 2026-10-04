/**
 * The events directory, through `GET /api/events`.
 *
 * It filters in SQL and counts entrants per event in SQL now, for the page it
 * returns, rather than loading every event and every entrant. What must not
 * change is who sees what (a club event for its members, a private one for
 * its host and entrants), the filters, the order, `meta`, and the numbers on
 * each card.
 *
 * Host runs a club and hosts three events, one of each visibility, all
 * carrying a token in their names so `?q=` finds exactly them in a database
 * other suites write to. Member belongs to the club. Stranger belongs to
 * nothing, and enters the public event.
 *
 * `tests/unit/event-directory.test.ts` checks the same SQL against the old
 * in-memory code on mixed data; this is the request the app makes.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, APP, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

const DAY = 24 * 60 * 60 * 1000
const TOKEN = crypto.randomUUID().slice(0, 8)
const CLUB_NAME = `Events QA ${TOKEN} Striders`

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
    name: `Events QA ${role}`,
    email: `events-${role.toLowerCase()}-${crypto.randomUUID()}@example.test`,
    password: `Local-QA-${crypto.randomUUID()}`,
  }
  const registered = await send('/register', 'POST', account)
  expect(registered.status, await registered.clone().text()).toBe(200)
  const loggedIn = await send('/login', 'POST', { email: account.email, password: account.password })
  expect(loggedIn.status, await loggedIn.clone().text()).toBe(200)
  const session = await loggedIn.json()
  return { id: Number(session.user.id), token: session.token }
}

async function directory(query: string, token?: string): Promise<any> {
  const response = await fetch(`${API}/events?q=${TOKEN}${query ? `&${query}` : ''}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  expect(response.status, await response.clone().text()).toBe(200)
  const payload = await response.json()
  expect(payload.success).toBe(true)
  return payload
}

const ids = (payload: any): number[] => payload.events.map((event: any) => event.id)

let host = { id: 0, token: '' }
let member = { id: 0, token: '' }
let stranger = { id: 0, token: '' }
let clubId = 0
const event = { open: 0, club: 0, invite: 0 }
let openStart = ''

async function hostEvent(body: Record<string, unknown>): Promise<number> {
  const created = await send('/events', 'POST', body, host.token)
  expect(created.status, await created.clone().text()).toBe(201)
  return Number((await created.json()).event.id)
}

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()

  host = await athlete('Host')
  member = await athlete('Member')
  stranger = await athlete('Stranger')

  const club = await send('/clubs', 'POST', { name: CLUB_NAME, club_type: 'Running', location: 'Denver, CO' }, host.token)
  expect(club.status, await club.clone().text()).toBe(201)
  clubId = Number((await club.json()).club.id)
  const joined = await send(`/clubs/${clubId}/join`, 'POST', {}, member.token)
  expect(joined.status, await joined.clone().text()).toBe(200)

  const now = Date.now()
  openStart = new Date(now + 3 * DAY).toISOString()
  event.club = await hostEvent({ name: `Events QA ${TOKEN} Club Run`, event_type: 'group_run', visibility: 'club', club_id: clubId, start_time: new Date(now + 2 * DAY).toISOString() })
  event.open = await hostEvent({ name: `Events QA ${TOKEN} Open Backyard`, location: 'Denver, CO', lat: 39.74, lng: -104.98, start_time: openStart })
  event.invite = await hostEvent({ name: `Events QA ${TOKEN} Invite Race`, event_type: 'race', visibility: 'private', start_time: new Date(now + 4 * DAY).toISOString() })

  const entered = await send(`/events/${event.open}/join`, 'POST', {}, stranger.token)
  expect(entered.status, await entered.clone().text()).toBe(200)
}, READY_TIMEOUT_MS + 60_000)

describe.skipIf(!qa)('events directory', () => {
  it('lists only the public event to someone signed out, with its field', async () => {
    const payload = await directory('')

    expect(ids(payload)).toEqual([event.open])
    expect(payload.events[0]).toMatchObject({
      name: `Events QA ${TOKEN} Open Backyard`,
      description: null,
      location: 'Denver, CO',
      lat: 39.74,
      lng: -104.98,
      type: 'backyard',
      status: 'scheduled',
      visibility: 'public',
      hostId: host.id,
      clubId: null,
      clubName: null,
      trailId: null,
      yardMinutes: 60,
      startTime: openStart,
      maxYards: null,
      winnerId: null,
      // The host and the stranger, both still in before the gun.
      entrantCount: 2,
      stillIn: 2,
      currentYard: 0,
      leaderYards: 0,
      isEntered: false,
    })
    expect(payload.events[0].createdAt).toEqual(expect.any(String))
    expect(payload.meta).toEqual({ offset: 0, limit: 60, total: 1, hasMore: false })
  })

  it('shows the host all three, soonest first', async () => {
    const payload = await directory('', host.token)

    expect(ids(payload)).toEqual([event.club, event.open, event.invite])
    expect(payload.events.every((e: any) => e.isEntered)).toBe(true)
    expect(payload.events[0]).toMatchObject({ clubId, clubName: CLUB_NAME, type: 'group_run', visibility: 'club', entrantCount: 1 })
  })

  it('shows a club member the club event, but not the private one', async () => {
    const payload = await directory('', member.token)

    expect(ids(payload)).toEqual([event.club, event.open])
    expect(payload.events.some((e: any) => e.isEntered)).toBe(false)
  })

  it('shows an entrant they are entered', async () => {
    const payload = await directory('', stranger.token)

    expect(ids(payload)).toEqual([event.open])
    expect(payload.events[0]).toMatchObject({ isEntered: true, entrantCount: 2 })
  })

  it('filters by type, club, status and text', async () => {
    expect(ids(await directory('type=group_run', host.token))).toEqual([event.club])
    expect(ids(await directory(`club=${clubId}`, host.token))).toEqual([event.club])
    expect(ids(await directory('status=live', host.token))).toEqual([])
    expect(ids(await directory('status=scheduled&type=race', host.token))).toEqual([event.invite])
    // Not a type: ignored, as it always was.
    expect(ids(await directory('type=marathon', host.token))).toHaveLength(3)

    const upper = await fetch(`${API}/events?q=${TOKEN.toUpperCase()}%20open`)
    expect(ids(await upper.json())).toEqual([event.open])
  })

  it('pages after sorting, and counts every match in meta', async () => {
    const payload = await directory('limit=1&offset=1', host.token)

    expect(ids(payload)).toEqual([event.open])
    expect(payload.meta).toEqual({ offset: 1, limit: 1, total: 3, hasMore: true })
  })
})

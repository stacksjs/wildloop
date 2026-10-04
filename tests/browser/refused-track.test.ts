/**
 * A track the integrity checks refuse on physics, through the API the
 * recorder calls.
 *
 * It used to be answered with a 422 and the athlete lost the run from their
 * log along with its score. It is saved now, non-scoring and marked
 * `rejected` with the reason, and it must still never reach anything a game
 * or a board is built from: no claim, no conquest, no place on the
 * leaderboards. An upload that is not a track at all is still refused.
 *
 * The refused track is a closed loop at 40 m/s — a loop that would claim
 * ground if it were let through, so a refused claim means something. The
 * athlete also records one honest free run, so their leaderboard row shows
 * exactly what was left out rather than being empty for some other reason.
 *
 * `tests/unit/activity-store-decision.test.ts` covers the decision itself.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, APP, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

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

async function read(path: string, token?: string): Promise<any> {
  const response = await fetch(`${API}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json()
}

/** Register and sign in a fresh athlete. */
async function athlete(): Promise<{ id: number, token: string }> {
  const account = {
    name: `Refused QA ${crypto.randomUUID().slice(0, 8)}`,
    email: `refused-${crypto.randomUUID()}@example.test`,
    // Test-only credentials for the throwaway QA database.
    password: `Local-QA-${crypto.randomUUID()}`,
  }
  const registered = await send('/register', 'POST', account)
  expect(registered.status, await registered.clone().text()).toBe(200)
  const loggedIn = await send('/login', 'POST', { email: account.email, password: account.password })
  expect(loggedIn.status, await loggedIn.clone().text()).toBe(200)
  const session = await loggedIn.json()
  return { id: Number(session.user.id), token: session.token }
}

/** Metres to degrees, near enough at 40° north. */
const LAT_PER_M = 1 / 111_320
const LNG_PER_M = 1 / 85_390

/**
 * A GeoJSON track of `steps` fixes a second apart, ending now, walked by
 * `at(index)` metres east and north of the start.
 */
function track(steps: number, at: (index: number) => [east: number, north: number], origin: [lng: number, lat: number]): string {
  const end = Date.now()
  const coordinates: number[][] = []
  const samples: Array<{ time: number, accuracy: number, altitude: number }> = []
  for (let index = 0; index <= steps; index++) {
    const [east, north] = at(index)
    coordinates.push([origin[0] + east * LNG_PER_M, origin[1] + north * LAT_PER_M])
    samples.push({ time: end - (steps - index) * 1000, accuracy: 5, altitude: 1600 })
  }
  return JSON.stringify({ type: 'LineString', coordinates, properties: { samples } })
}

/** A 600 m square at 40 m/s: a car going round the block, one fix a second. */
function carLoop(origin: [number, number]): string {
  const side = 15
  const metres = 40
  return track(side * 4, (index) => {
    const leg = Math.floor(index / side)
    const along = (index % side) * metres
    const full = side * metres
    return leg === 0 ? [along, 0] : leg === 1 ? [full, along] : leg === 2 ? [full - along, full] : leg === 3 ? [0, full - along] : [0, 0]
  }, origin)
}

/** Three and a half minutes at 3 m/s, which is an honest run. */
function honestRun(origin: [number, number]): string {
  return track(210, index => [index * 3, 0], origin)
}

// Somewhere no other suite plays, so no claim of theirs is in the way.
const ORIGIN: [number, number] = [-105.62, 40.21]

let runner = { id: 0, token: '' }
let refused: any = null
let uploadId = ''
let refusedPayload: Record<string, unknown> = {}

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
  runner = await athlete()

  uploadId = `qa-refused:${crypto.randomUUID()}`
  refusedPayload = {
    activity_type: 'Trail Run',
    // What the phone said; the server measures the track instead.
    distance: 0.5,
    duration: '1:00',
    visibility: 'public',
    recording_source: 'web_gps',
    game_mode: 'capture',
    completed_at: new Date().toISOString(),
    upload_id: uploadId,
    gpx_data: carLoop(ORIGIN),
  }
  const stored = await send('/activities', 'POST', refusedPayload, runner.token)
  expect(stored.status, await stored.clone().text()).toBe(201)
  refused = (await stored.json()).activity

  const honest = await send('/activities', 'POST', {
    activity_type: 'Trail Run',
    distance: 0.4,
    duration: '3:30',
    visibility: 'public',
    recording_source: 'web_gps',
    game_mode: 'free',
    completed_at: new Date().toISOString(),
    upload_id: `qa-honest:${crypto.randomUUID()}`,
    gpx_data: honestRun([ORIGIN[0] + 0.05, ORIGIN[1]]),
  }, runner.token)
  expect(honest.status, await honest.clone().text()).toBe(201)
  expect((await honest.json()).activity.integrityStatus).toBe('verified')
}, READY_TIMEOUT_MS + 60_000)

describe.skipIf(!qa)('a track refused on physics', () => {
  it('is saved to the log, non-scoring, with the reason', () => {
    expect(refused).toMatchObject({
      userId: runner.id,
      hasGps: true,
      gameMode: 'capture',
      captureEligible: false,
      integrityStatus: 'rejected',
    })
    expect(refused.integrityReason).toMatch(/implausible trail run speed/)
    // 60 steps of 40 m, measured from the fixes rather than taken from the phone.
    expect(refused.distance).toBeGreaterThan(1.3)
    expect(refused.duration).toBe('1:00')
  })

  it('is saved once, however often the upload is retried', async () => {
    const replay = await send('/activities', 'POST', refusedPayload, runner.token)
    expect(replay.status, await replay.clone().text()).toBe(200)
    const body = await replay.json()
    expect(body).toMatchObject({ success: true, alreadyProcessed: true })
    expect(body.activity).toMatchObject({ id: refused.id, integrityStatus: 'rejected' })

    const log = await read(`/activities?user_id=${runner.id}&limit=50`, runner.token)
    expect(log.activities.filter((a: any) => a.id === refused.id)).toHaveLength(1)
    expect(log.activities).toHaveLength(2)
  })

  it('shows the reason to the athlete, and to nobody else', async () => {
    const own = (await read(`/activities/${refused.id}`, runner.token)).activity
    expect(own).toMatchObject({ integrityStatus: 'rejected', integrityReason: refused.integrityReason })

    const theirs = (await read(`/activities/${refused.id}`)).activity
    expect(theirs.id).toBe(refused.id)
    expect(theirs.integrityStatus).toBeUndefined()
    expect(theirs.integrityReason).toBeUndefined()
  })

  it('never claims or conquers territory', async () => {
    for (const path of ['/territories/claim', '/territories/process-conquest']) {
      const attempt = await send(path, 'POST', { activity_id: refused.id }, runner.token)
      expect(attempt.status, await attempt.clone().text()).toBe(422)
      expect(await attempt.json()).toMatchObject({ success: false, code: 'capture_ineligible', error: refused.integrityReason })
    }

    const held = await read(`/territories/user/${runner.id}`)
    expect(held.territories).toEqual([])
  })

  it('is on no leaderboard, while the honest run beside it is', async () => {
    const rowOf = (payload: any) => payload.leaderboard.find((row: any) => row.userId === runner.id)

    for (const query of ['period=weekly', 'period=monthly', 'period=alltime', 'period=weekly&metric=activities']) {
      const row = rowOf(await read(`/activities/leaderboard?${query}`))
      expect(row, query).toBeDefined()
      expect(row.trailsCompleted, query).toBe(1)
      expect(row.totalDistance, query).toBeLessThan(1)
    }
    expect((await read('/activities/leaderboard?period=weekly&scope=following', runner.token)).leaderboard)
      .toMatchObject([{ userId: runner.id, trailsCompleted: 1 }])
  })
})

describe.skipIf(!qa)('an upload that is not a track', () => {
  it('is still refused, and nothing is saved', async () => {
    for (const gpx_data of ['not json', '[]', JSON.stringify([{ lat: 40.21, lng: -105.62 }, { lat: 140.21, lng: -105.62 }])]) {
      const response = await send('/activities', 'POST', { ...refusedPayload, upload_id: `qa-malformed:${crypto.randomUUID()}`, gpx_data }, runner.token)
      expect(response.status, gpx_data).toBe(422)
      const body = await response.json()
      expect(body.fields?.gpx_data, gpx_data).toBeTruthy()
    }

    const log = await read(`/activities?user_id=${runner.id}&limit=50`, runner.token)
    expect(log.activities).toHaveLength(2)
  })
})

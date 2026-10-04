/**
 * PATCH /api/privacy-settings changes what it names, and nothing else.
 *
 * It used to answer 422 to any request that left a field out, and its write
 * reset every field left out to a default — so a request that only turned on
 * precise territories would have cleared the athlete's home zone, the setting
 * that keeps the territory game away from where they live.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, APP, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

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

let bearer = ''

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
  const account = {
    name: 'Privacy QA',
    email: `privacy-${crypto.randomUUID()}@example.test`,
    password: `Local-QA-${crypto.randomUUID()}`,
  }
  expect((await send('/register', 'POST', account)).status).toBe(200)
  bearer = (await (await send('/login', 'POST', { email: account.email, password: account.password })).json()).token
}, READY_TIMEOUT_MS + 30_000)

describe.skipIf(!qa)('privacy settings', () => {
  it('keeps the home zone when another setting changes', async () => {
    const home = await send('/privacy-settings', 'PATCH', {
      home_lat: 34.0268,
      home_lng: -118.4733,
      home_radius_meters: 800,
      hide_start_end_meters: 600,
    }, bearer)
    expect(home.status, await home.clone().text()).toBe(200)

    const precise = await send('/privacy-settings', 'PATCH', { show_precise_territories: true }, bearer)
    expect(precise.status, await precise.clone().text()).toBe(200)
    expect((await precise.json()).settings).toMatchObject({
      homeLat: 34.0268,
      homeLng: -118.4733,
      homeRadiusMeters: 800,
      hideStartEndMeters: 600,
      excludeHomeFromGame: true,
      showPreciseTerritories: true,
      defaultActivityVisibility: 'followers',
    })
  })

  it('refuses half a home, and a value out of range', async () => {
    const half = await send('/privacy-settings', 'PATCH', { home_lat: 40 }, bearer)
    expect(half.status).toBe(422)
    expect((await half.json()).fields.home).toBeTruthy()

    const far = await send('/privacy-settings', 'PATCH', { home_radius_meters: 99999 }, bearer)
    expect(far.status).toBe(422)
    expect((await far.json()).fields.home_radius_meters).toBeTruthy()
  })

  it('clears the home zone only when asked to', async () => {
    const cleared = await send('/privacy-settings', 'PATCH', { home_lat: null, home_lng: null }, bearer)
    expect(cleared.status, await cleared.clone().text()).toBe(200)
    expect((await cleared.json()).settings).toMatchObject({ homeLat: null, homeLng: null, showPreciseTerritories: true })
  })
})

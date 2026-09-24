/**
 * The API and the dashboard each load the app's route registry. The dashboard
 * used to omit runtime initialization, so working API actions returned 500
 * there (#2789).
 *
 * This ran under Playwright as `api-startup.pw.ts`, which only ever used its
 * HTTP client: no page, no browser. It is the same suite against `fetch`, so
 * it needs neither Chromium nor a DOM. `scripts/start-recording-qa.ts` boots
 * both servers against a throwaway SQLite database, never the developer's.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { API, DASHBOARD, csrfToken, READY_TIMEOUT_MS, startQaServers, stopQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

const ORIGIN = 'http://127.0.0.1:4320'

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
}, READY_TIMEOUT_MS + 10_000)

afterAll(() => {
  stopQaServers()
})

for (const [name, base] of [['API', API], ['dashboard', DASHBOARD]] as const) {
  describe.skipIf(!qa)(`${name} startup`, () => {
    it('loads the app actions', async () => {
      const trails = await fetch(`${base}/trails`)
      expect(trails.status).toBe(200)
      expect((await trails.json()).trails).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'Torrey Pines Loop' }),
      ]))

      const controller = await fetch(`${base}/coming-soon`)
      expect(controller.status).toBe(200)
      expect(await controller.text()).toContain('Coming Soon v2')

      // Imports the real elevation provider; validation stops before any
      // external call.
      expect((await fetch(`${base}/geo/climb`)).status).toBe(422)
    })

    it('keeps authentication and CSRF in front of the actions', async () => {
      expect((await fetch(`${base}/plans`)).status).toBe(401)

      const withoutToken = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN },
        body: JSON.stringify({ name: 'Startup QA', email: 'no-csrf@example.test', password: 'Local-QA-invalid-request' }),
      })
      expect(withoutToken.status).toBe(403)
    })

    it('registers an athlete and keeps their plans to themselves', async () => {
      const token = await csrfToken(base)
      const email = `startup-${crypto.randomUUID()}@example.test`
      const registered = await fetch(`${base}/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Origin': ORIGIN,
          'X-CSRF-Token': token,
          'Cookie': `X-CSRF-Token=${encodeURIComponent(token)}`,
        },
        body: JSON.stringify({ name: 'Startup QA', email, password: `Local-QA-${crypto.randomUUID()}` }),
      })
      expect(registered.status, await registered.clone().text()).toBe(200)
      const bearer = (await registered.json()).token
      expect(bearer).toBeTruthy()

      const headers = { 'Authorization': `Bearer ${bearer}`, 'Content-Type': 'application/json' }
      // An ordinary athlete cannot run the maintenance actions.
      for (const path of ['/territories/recompute-ranks', '/maintenance/recompute-counters'])
        expect((await fetch(`${base}${path}`, { method: 'POST', headers })).status).toBe(403)

      const created = await fetch(`${base}/plans`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          title: 'Startup route check',
          latitude: 32.9209,
          longitude: -117.2528,
          planned_for: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
        }),
      })
      expect(created.status, await created.clone().text()).toBe(201)
      const { plan } = await created.json()

      const listed = await fetch(`${base}/plans`, { headers })
      expect(listed.status).toBe(200)
      expect((await listed.json()).plans).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: plan.id, title: 'Startup route check' }),
      ]))
    })
  })
}

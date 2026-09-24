import { expect, test } from '@playwright/test'

// Both servers load the app's route registry. The dashboard used to omit
// runtime initialization, so working API actions returned 500 there (#2789).
for (const [name, port] of [['API', 4321], ['dashboard', 4332]] as const) {
  test(`${name} loads app actions and preserves authentication and CSRF`, async ({ request }) => {
    const base = `http://127.0.0.1:${port}/api`
    await expect.poll(async () => {
      try {
        return (await request.get(`${base}/json`)).status()
      }
      catch {
        return 0
      }
    }).toBe(200)

    const trails = await request.get(`${base}/trails`)
    expect(trails.status(), await trails.text()).toBe(200)
    expect((await trails.json()).trails).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Torrey Pines Loop' }),
    ]))
    const controller = await request.get(`${base}/coming-soon`)
    expect(controller.status()).toBe(200)
    expect(await controller.text()).toContain('Coming Soon v2')
    // Imports the real elevation provider, but validation avoids external I/O.
    expect((await request.get(`${base}/geo/climb`)).status()).toBe(422)
    expect((await request.get(`${base}/plans`)).status()).toBe(401)
    expect((await request.post(`${base}/register`, {
      headers: { Origin: 'http://127.0.0.1:4320' },
      data: { name: 'Startup QA', email: 'no-csrf@example.test', password: 'Local-QA-invalid-request' },
    })).status()).toBe(403)

    const csrf = (await request.storageState()).cookies.find(cookie => cookie.name === 'X-CSRF-Token')
    expect(csrf).toBeDefined()
    const email = `startup-${crypto.randomUUID()}@example.test`
    const password = `Local-QA-${crypto.randomUUID()}`
    const registered = await request.post(`${base}/register`, {
      headers: { 'X-CSRF-Token': decodeURIComponent(csrf!.value), Origin: 'http://127.0.0.1:4320' },
      data: { name: 'Startup QA', email, password },
    })
    expect(registered.status()).toBe(200)
    const { token } = await registered.json()
    expect(token).toBeTruthy()
    const headers = { Authorization: `Bearer ${token}` }
    for (const path of ['/territories/recompute-ranks', '/maintenance/recompute-counters']) {
      expect((await request.post(`${base}${path}`, { headers })).status()).toBe(403)
    }

    const created = await request.post(`${base}/plans`, {
      headers,
      data: {
        title: 'Startup route check',
        latitude: 32.9209,
        longitude: -117.2528,
        planned_for: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
      },
    })
    expect(created.status(), await created.text()).toBe(201)
    const { plan } = await created.json()
    const listed = await request.get(`${base}/plans`, { headers })
    expect(listed.status()).toBe(200)
    expect((await listed.json()).plans).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: plan.id, title: 'Startup route check' }),
    ]))
  })
}

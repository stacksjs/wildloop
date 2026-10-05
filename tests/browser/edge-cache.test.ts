/**
 * What a real server tells Cloudflare it may keep.
 *
 * The unit tests pin the decision; these pin that the decision reaches the
 * wire, through the router, the CSRF seeding and the page server's API proxy.
 * Every header asserted here is one the edge acts on: a `public` answer is
 * served to the next person who asks, so a signed-in request must never get
 * one, and a `public` answer must never carry a `Set-Cookie`.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, APP, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// Boots the isolated QA app, so the ordinary `bun test` run skips it.
const qa = process.env.RECORDING_QA === '1'

const account = {
  name: 'Edge Cache QA',
  email: `edge-${crypto.randomUUID()}@example.test`,
  password: `Local-QA-${crypto.randomUUID()}`,
}

let bearer = ''
let trailId = 0
let trailLat = 0
let trailLng = 0

/** Every response this file saw, for the sweep at the end. */
const seen: Array<{ label: string, response: Response }> = []

async function get(url: string, headers: Record<string, string> = {}): Promise<Response> {
  const response = await fetch(url, { headers: { accept: 'application/json', ...headers } })
  seen.push({ label: `GET ${url} ${JSON.stringify(Object.keys(headers))}`, response: response.clone() })
  return response
}

function cacheControl(response: Response): string {
  return (response.headers.get('cache-control') ?? '').toLowerCase()
}

function isPublic(response: Response): boolean {
  const value = cacheControl(response)
  return !/\b(?:private|no-store)\b/.test(value) && (/\bpublic\b/.test(value) || /\bs-maxage\s*=/.test(value))
}

function expectShared(response: Response, label: string, sMaxAge: number): void {
  expect(response.status, label).toBe(200)
  expect(cacheControl(response), label).toContain('public')
  expect(cacheControl(response), label).toContain(`s-maxage=${sMaxAge}`)
  expect(response.headers.getSetCookie(), `${label} sets no cookie`).toEqual([])
  expect(response.headers.get('vary') ?? '', `${label} varies on Authorization for the browser`).toMatch(/authorization/i)
  expect(response.headers.get('access-control-allow-origin'), `${label} is open to any origin`).toBe('*')
}

function expectPrivate(response: Response, label: string): void {
  expect(isPublic(response), `${label}: ${cacheControl(response) || '(no cache-control)'}`).toBe(false)
}

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()

  const token = await csrfToken(API)
  const registered = await fetch(`${API}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': APP,
      'X-CSRF-Token': token,
      'Cookie': `X-CSRF-Token=${encodeURIComponent(token)}`,
    },
    body: JSON.stringify(account),
  })
  expect(registered.status, await registered.clone().text()).toBe(200)
  bearer = (await registered.json()).token
  expect(bearer, 'register returns a bearer token').toBeTruthy()

  const list = await fetch(`${API}/trails?limit=1&sort=featured&country=all`)
  const trail = (await list.json()).trails?.[0]
  expect(trail?.id, 'the QA catalog must have a trail').toBeDefined()
  trailId = Number(trail.id)
  trailLat = Math.round(Number(trail.lat) * 100) / 100
  trailLng = Math.round(Number(trail.lng) * 100) / 100
}, READY_TIMEOUT_MS + 30_000)

describe.skipIf(!qa)('public catalog reads, signed out', () => {
  it('shares a near-me list, directly and through the page server\'s proxy', async () => {
    const path = `/trails?lat=${trailLat}&lng=${trailLng}&limit=5`
    expectShared(await get(`${API}${path}`), 'api near-me', 300)
    expectShared(await get(`${APP}/api${path}`), 'proxied near-me', 300)
  })

  it('shares a list filtered by an explicit country', async () => {
    expectShared(await get(`${API}/trails?limit=5&sort=popular&country=all`), 'country=all', 300)
  })

  it('does not share a list filtered by a country guessed from headers', async () => {
    // Without a location or ?country=, the API narrows by CF-IPCountry or
    // Accept-Language — headers the edge's cache key does not include.
    const response = await get(`${API}/trails?limit=5&sort=popular`, { 'accept-language': 'de-DE' })
    expect(response.status).toBe(200)
    expectPrivate(response, 'inferred country')
    expect(cacheControl(response)).toContain('no-store')
  })

  it('shares one trail, coverage counts and search suggestions', async () => {
    expectShared(await get(`${API}/trails/${trailId}`), 'trail detail', 3600)
    expectShared(await get(`${API}/trails/stats`), 'coverage', 600)
    expectShared(await get(`${API}/search/suggest?q=tr`), 'suggest', 600)
  })

  it('still shares when the only cookie is the CSRF one every visitor carries', async () => {
    expectShared(await get(`${API}/trails/${trailId}`, { cookie: 'X-CSRF-Token=abc' }), 'csrf cookie only', 3600)
  })

  it('never shares a trail that is not there', async () => {
    expectPrivate(await get(`${API}/trails/999999999`), 'missing trail')
  })
})

describe.skipIf(!qa)('the same reads, signed in', () => {
  it('are private with a bearer token', async () => {
    for (const path of [`/trails?lat=${trailLat}&lng=${trailLng}&limit=5`, `/trails/${trailId}`, '/trails/stats', '/search/suggest?q=tr', '/trails?limit=5&sort=recommended&country=all']) {
      const response = await get(`${API}${path}`, { authorization: `Bearer ${bearer}` })
      expect(response.status, path).toBe(200)
      expect(cacheControl(response), path).toBe('private, no-store')
    }
  })

  it('are private with a sign-in hand-off cookie', async () => {
    const response = await get(`${API}/trails/${trailId}`, { cookie: 'X-CSRF-Token=abc; wl_google_handoff=xyz' })
    expect(cacheControl(response)).toBe('private, no-store')
  })

  it('are private through the proxy too', async () => {
    const response = await get(`${APP}/api/trails/${trailId}`, { authorization: `Bearer ${bearer}` })
    expectPrivate(response, 'proxied signed-in detail')
  })
})

describe.skipIf(!qa)('what is never public', () => {
  it('the account, signed in or not', async () => {
    expectPrivate(await get(`${API}/me`, { authorization: `Bearer ${bearer}` }), '/me signed in')
    expectPrivate(await get(`${API}/me`), '/me signed out')
    expectPrivate(await get(`${API}/me/completed-trails`, { authorization: `Bearer ${bearer}` }), '/me/completed-trails')
    expectPrivate(await get(`${API}/notifications`, { authorization: `Bearer ${bearer}` }), '/notifications')
  })

  it('sign-in, the admin and where the visitor is', async () => {
    expectPrivate(await get(`${API}/auth/google/redirect`), 'google redirect')
    expectPrivate(await get(`${API}/admin/overview`, { authorization: `Bearer ${bearer}` }), 'admin')
    expectPrivate(await get(`${API}/geo/here`), 'geo/here')
  })

  it('any write', async () => {
    const view = await fetch(`${API}/trails/${trailId}/view`, { method: 'POST', headers: { Origin: APP } })
    seen.push({ label: 'POST view', response: view.clone() })
    expectPrivate(view, 'POST /trails/{id}/view')

    const token = await csrfToken(API)
    const login = await fetch(`${API}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Origin': APP, 'X-CSRF-Token': token, 'Cookie': `X-CSRF-Token=${encodeURIComponent(token)}` },
      body: JSON.stringify({ email: account.email, password: account.password }),
    })
    seen.push({ label: 'POST login', response: login.clone() })
    expect(login.status).toBe(200)
    expectPrivate(login, 'POST /login')
  })

  it('the CSRF bootstrap, which plants the cookie every time it is asked', async () => {
    const response = await get(`${API}/csrf`)
    expect(response.status).toBe(200)
    expect(cacheControl(response)).toBe('private, no-store')
    expect(response.headers.getSetCookie().some(cookie => cookie.startsWith('X-CSRF-Token='))).toBe(true)
  })
})

describe.skipIf(!qa)('pages', () => {
  async function page(path: string, headers: Record<string, string> = {}): Promise<Response> {
    const response = await fetch(`${APP}${path}`, { headers: { accept: 'text/html', ...headers } })
    seen.push({ label: `page ${path} ${JSON.stringify(Object.keys(headers))}`, response: response.clone() })
    return response
  }

  it('never embed the visitor\'s CSRF token, so a copy at the edge carries nobody\'s', async () => {
    for (const path of ['/', '/trails', `/trail/${trailId}`, '/support', '/privacy', '/terms']) {
      const response = await page(path)
      expect(response.status, path).toBe(200)
      const html = await response.text()
      for (const cookie of response.headers.getSetCookie()) {
        const value = cookie.match(/^X-CSRF-Token=([^;]+)/)?.[1]
        if (value)
          expect(html.includes(value), `${path} embeds its CSRF token`).toBe(false)
      }
    }
  })

  it('are never public for a signed-in request', async () => {
    for (const path of ['/', `/trail/${trailId}`])
      expectPrivate(await page(path, { authorization: `Bearer ${bearer}`, cookie: 'X-CSRF-Token=abc' }), `${path} signed in`)
  })
})

describe.skipIf(!qa)('every response above', () => {
  it('that is public sets no cookie', () => {
    expect(seen.length).toBeGreaterThan(20)
    const leaks = seen
      .filter(({ response }) => isPublic(response) && response.headers.getSetCookie().length > 0)
      .map(({ label }) => label)
    expect(leaks).toEqual([])
  })
})

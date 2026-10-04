/**
 * Reviewing Commons photographs for trail covers (#1006), against a real
 * server and a throwaway database.
 *
 * `scripts/start-recording-qa.ts` seeds the queue from a recorded-shape
 * Commons answer (fixtures/commons-geosearch-sedona.json) through the same
 * parsing and licence rules the nightly job uses, so nothing here reaches
 * Wikimedia. The unit suite proves the rules; this one proves what only a
 * server can: the queue is closed to anybody who is not an admin, a
 * non-commercial file never reaches it, and an approval is what makes a
 * photo the trail's cover — with its credit and licence — and an undo is
 * what takes it off again.
 *
 * Every test leaves the queue as it found it, so a stack reused from an
 * earlier run answers the same.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { QA_ADMIN } from './qa-admin'
import { API, APP, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
const qa = process.env.RECORDING_QA === '1'

const stranger = {
  name: 'Photo Review QA',
  email: `photo-review-${crypto.randomUUID()}@example.test`,
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

const bearer = (token: string | null): Record<string, string> => token ? { Authorization: `Bearer ${token}` } : {}

function queue(token: string | null): Promise<Response> {
  return fetch(`${API}/admin/trail-photos`, { headers: bearer(token) })
}

function review(token: string | null, id: number, decision: unknown, note?: string): Promise<Response> {
  return fetch(`${API}/admin/trail-photos/${id}/review`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(token) },
    body: JSON.stringify({ decision, ...(note ? { note } : {}) }),
  })
}

async function trail(id: number): Promise<Record<string, any>> {
  const response = await fetch(`${API}/trails/${id}`)
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()).trail
}

interface QueueTrail { id: number, name: string, candidates: Array<{ id: number, title: string, license: string, licenseUrl: string, credit: string, url: string }> }

async function pending(token: string): Promise<{ trails: QueueTrail[], pendingTrails: number, pendingCandidates: number }> {
  const response = await queue(token)
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json()
}

const byName = (trails: QueueTrail[], name: string) => trails.find(entry => entry.name === name)

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

describe.skipIf(!qa)('the trail photo review queue', () => {
  it('is closed to anybody who is not an admin', async () => {
    const anonymous = await queue(null)
    expect([401, 403], await anonymous.clone().text()).toContain(anonymous.status)
    const athlete = await queue(strangerToken)
    expect(athlete.status, await athlete.clone().text()).toBe(403)

    const { trails } = await pending(adminToken)
    const candidate = byName(trails, 'Cathedral Rock Trail')!.candidates[0]
    const refused = await review(strangerToken, candidate.id, 'approve')
    expect(refused.status, await refused.clone().text()).toBe(403)
    expect(byName((await pending(adminToken)).trails, 'Cathedral Rock Trail')).toBeDefined()
  })

  /*
   * The fixture holds five files: two usable ones for Cathedral Rock, one
   * under CC BY-NC-SA, one usable for Devils Bridge, and a pine tree whose
   * title names neither trail. Only the three usable ones are offered.
   */
  it('offers only files that name the trail under a licence a cover can carry', async () => {
    const { trails } = await pending(adminToken)
    const cathedral = byName(trails, 'Cathedral Rock Trail')
    const devils = byName(trails, 'Devils Bridge Trail')
    expect(cathedral, JSON.stringify(trails)).toBeDefined()
    expect(devils, JSON.stringify(trails)).toBeDefined()

    expect(cathedral!.candidates.map(c => c.title).sort()).toEqual([
      'Cathedral Rock from Oak Creek Crossing.jpg',
      'Cathedral Rock trailhead sign.jpg',
    ])
    expect(devils!.candidates.map(c => [c.title, c.license])).toEqual([['Devils Bridge, Sedona, Arizona.jpg', 'CC0']])

    const all = trails.flatMap(entry => entry.candidates)
    expect(all.some(c => /NC/.test(c.license))).toBe(false)
    expect(all.some(c => /Pinus/.test(c.title))).toBe(false)

    // Credit is plain text, and every candidate links to its terms.
    const oakCreek = cathedral!.candidates.find(c => c.title.includes('Oak Creek'))!
    expect(oakCreek.credit).toBe('QA Hiker')
    expect(oakCreek.licenseUrl).toBe('https://creativecommons.org/licenses/by-sa/4.0')
    const sign = cathedral!.candidates.find(c => c.title.includes('sign'))!
    expect(sign.licenseUrl).toContain('commons.wikimedia.org/wiki/File:')
    // Higher priority first: the seed ranks Cathedral Rock above Devils Bridge.
    expect(trails.indexOf(cathedral!)).toBeLessThan(trails.indexOf(devils!))
  })

  it('refuses a decision it does not know', async () => {
    const { trails } = await pending(adminToken)
    const candidate = byName(trails, 'Devils Bridge Trail')!.candidates[0]
    const response = await review(adminToken, candidate.id, 'delete')
    expect(response.status, await response.clone().text()).toBe(422)
    expect((await response.json()).fields.decision).toContain('approve')

    const missing = await review(adminToken, 999_999_999, 'approve')
    expect(missing.status, await missing.clone().text()).toBe(404)
  })

  it('makes a photo the cover only once approved, with its credit and licence, and takes it off on reopen', async () => {
    const { trails } = await pending(adminToken)
    const cathedral = byName(trails, 'Cathedral Rock Trail')!
    const photo = cathedral.candidates.find(c => c.title.includes('Oak Creek'))!

    const before = await trail(cathedral.id)
    expect(before.image ?? '').not.toBe(photo.url)
    expect(before.coverLicense ?? null).toBeNull()

    const approved = await review(adminToken, photo.id, 'approve')
    expect(approved.status, await approved.clone().text()).toBe(200)
    expect(await approved.json()).toMatchObject({ success: true, id: photo.id, trailId: cathedral.id, status: 'approved' })

    try {
      const after = await trail(cathedral.id)
      expect(after.image).toBe(photo.url)
      expect(after.coverCredit).toBe('QA Hiker')
      expect(after.coverLicense).toBe('CC BY-SA 4.0')
      expect(after.coverLicenseUrl).toBe('https://creativecommons.org/licenses/by-sa/4.0')
      expect(after.coverSourceUrl).toContain('commons.wikimedia.org/wiki/File:')

      // A trail with its cover leaves the queue; the other one stays.
      const now = await pending(adminToken)
      expect(byName(now.trails, 'Cathedral Rock Trail')).toBeUndefined()
      expect(byName(now.trails, 'Devils Bridge Trail')).toBeDefined()
    }
    finally {
      const reopened = await review(adminToken, photo.id, 'reopen')
      expect(reopened.status, await reopened.clone().text()).toBe(200)
    }

    const undone = await trail(cathedral.id)
    expect(undone.image ?? '').not.toBe(photo.url)
    expect(byName((await pending(adminToken)).trails, 'Cathedral Rock Trail')?.candidates).toHaveLength(2)
  })

  it('rejects with the reviewer\'s note, out of the queue and off the trail', async () => {
    const { trails } = await pending(adminToken)
    const devils = byName(trails, 'Devils Bridge Trail')!
    const [photo] = devils.candidates

    const rejected = await review(adminToken, photo.id, 'reject', 'a different arch')
    expect(rejected.status, await rejected.clone().text()).toBe(200)
    try {
      expect(byName((await pending(adminToken)).trails, 'Devils Bridge Trail')).toBeUndefined()
      expect((await trail(devils.id)).image ?? '').not.toBe(photo.url)
    }
    finally {
      const reopened = await review(adminToken, photo.id, 'reopen')
      expect(reopened.status, await reopened.clone().text()).toBe(200)
    }
    expect(byName((await pending(adminToken)).trails, 'Devils Bridge Trail')).toBeDefined()
  })

  it('serves the review page', async () => {
    const response = await fetch(`${APP}/admin/photos`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('Trail photos')
  })
})

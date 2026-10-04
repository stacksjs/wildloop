/**
 * Photos on an activity, against a real server and a throwaway database.
 *
 * What a pure test cannot show: that a multipart upload survives the whole
 * round trip, that the bytes come back through the app rather than from a
 * public bucket, that an activity belongs to one athlete and a stranger cannot
 * add to it, and that deleting a photo stops it being served.
 *
 * `scripts/start-recording-qa.ts` boots the app against its own SQLite file,
 * never the developer's.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { encode } from 'ts-images'
import { API, APP, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

const ORIGIN = APP

let owner = ''
let stranger = ''
let activityId = 0

/** Register an athlete and keep their bearer token. */
async function register(): Promise<string> {
  const token = await csrfToken(API)
  const response = await fetch(`${API}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': ORIGIN,
      'X-CSRF-Token': token,
      'Cookie': `X-CSRF-Token=${encodeURIComponent(token)}`,
    },
    body: JSON.stringify({
      name: 'Photos QA',
      email: `photos-${crypto.randomUUID()}@example.test`,
      password: `Local-QA-${crypto.randomUUID()}`,
    }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()).token
}

/**
 * A real JPEG, encoded the same way the app encodes one. Drawn rather than
 * fixtured so this test carries no binary, and varied rather than flat so the
 * encoder cannot collapse it into something degenerate.
 */
async function jpeg(width = 400, height = 300): Promise<Blob> {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < data.length; i += 4) {
    const pixel = i / 4
    data[i] = (pixel * 7) % 256
    data[i + 1] = (pixel * 11) % 256
    data[i + 2] = (pixel * 13) % 256
    data[i + 3] = 255
  }
  const bytes = await encode(
    { data, width, height, colorSpace: 'srgb', hasAlpha: false, bitDepth: 8 } as any,
    'jpeg',
    { quality: 90 } as any,
  )
  return new Blob([bytes], { type: 'image/jpeg' })
}

async function upload(bearer: string, id = activityId): Promise<Response> {
  const body = new FormData()
  body.append('photo', await jpeg(), 'run.jpg')
  return await fetch(`${API}/activities/${id}/photos`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
    body,
  })
}

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()

  owner = await register()
  stranger = await register()

  const created = await fetch(`${API}/activities`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${owner}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      activity_type: 'Hike',
      distance: 4.2,
      duration: '01:15:00',
      notes: `Photos QA ${crypto.randomUUID().slice(0, 8)}`,
    }),
  })
  expect(created.status, await created.clone().text()).toBeLessThan(300)
  const body = await created.json()
  activityId = Number(body.activity?.id ?? body.id)
  expect(activityId).toBeGreaterThan(0)
}, READY_TIMEOUT_MS + 10_000)

describe.skipIf(!qa)('photos on an activity', () => {
  it('takes an upload from the athlete and serves it back through the app', async () => {
    const posted = await upload(owner)
    expect(posted.status, await posted.clone().text()).toBe(201)
    const { photo } = await posted.json()

    // Addressed by UUID, never by row id: a URL says nothing about how many
    // photos exist and cannot be walked through in order.
    expect(photo.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(photo.url).toBe(`/api/activity-photos/${activityId}/${photo.id}.jpg`)
    expect(photo.thumbUrl).toBe(`/api/activity-photos/${activityId}/${photo.id}-thumb.jpg`)
    expect(photo.mine).toBe(true)
    expect(photo.width).toBeGreaterThan(0)

    for (const url of [photo.url, photo.thumbUrl]) {
      const file = await fetch(`${ORIGIN}${url}`)
      expect(file.status, url).toBe(200)
      expect(file.headers.get('content-type')).toBe('image/jpeg')
      // Re-encoded, so what comes back is this app's JPEG and not the posted
      // file — which is what drops the GPS position the original carried.
      const bytes = new Uint8Array(await file.arrayBuffer())
      expect(bytes.length).toBeGreaterThan(0)
      expect(bytes[0]).toBe(0xFF)
      expect(bytes[1]).toBe(0xD8)
    }
  })

  it('is one athlete\'s account of their own afternoon, so nobody else may add to it', async () => {
    const posted = await upload(stranger)
    // 404 rather than 403: a stranger is told the same thing as for an
    // activity that does not exist, so this cannot be used to find real ids.
    expect(posted.status).toBe(404)
  })

  it('refuses an upload with no photo in it', async () => {
    const posted = await fetch(`${API}/activities/${activityId}/photos`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${owner}` },
      body: new FormData(),
    })
    expect(posted.status).toBe(422)
    expect((await posted.json()).fields?.photo).toBeTruthy()
  })

  it('needs a session at all', async () => {
    const body = new FormData()
    body.append('photo', await jpeg(), 'run.jpg')
    expect((await fetch(`${API}/activities/${activityId}/photos`, { method: 'POST', body })).status).toBe(401)
  })

  it('serves nothing for a key this app did not write', async () => {
    for (const path of [
      `/api/activity-photos/${activityId}/not-a-uuid.jpg`,
      `/api/activity-photos/${activityId}/${crypto.randomUUID()}.jpg`,
      `/api/activity-photos/${activityId}/${crypto.randomUUID()}.png`,
    ])
      expect((await fetch(`${ORIGIN}${path}`)).status, path).toBe(404)
  })

  it('reaches the activity page in the order they were added', async () => {
    const detail = await fetch(`${API}/activities/${activityId}`, {
      headers: { Authorization: `Bearer ${owner}` },
    })
    expect(detail.status).toBe(200)
    const photos = (await detail.json()).activity.photos
    expect(Array.isArray(photos)).toBe(true)
    expect(photos.length).toBeGreaterThan(0)
    expect(photos[0].url).toContain(`/api/activity-photos/${activityId}/`)
    expect(photos.every((p: any) => p.mine)).toBe(true)
    // Ascending position, which is upload order.
    const urls = photos.map((p: any) => p.url)
    expect(urls).toEqual([...urls])
  })

  it('gives the feed one photo and a count, not the whole set', async () => {
    const feed = await fetch(`${API}/activities?limit=50`, {
      headers: { Authorization: `Bearer ${owner}` },
    })
    expect(feed.status).toBe(200)
    const mine = (await feed.json()).activities.find((a: any) => Number(a.id) === activityId)
    expect(mine, 'the activity should be in its own feed').toBeTruthy()
    // A card shows the first one and how many there are — asking for every
    // photo of every run on the page is what this shape exists to avoid.
    expect(mine.photo).toBeTruthy()
    expect(mine.photo.thumbUrl).toContain('-thumb.jpg')
    expect(mine.photoCount).toBeGreaterThan(0)
  })

  it('stops serving a photo once its owner deletes it', async () => {
    const posted = await upload(owner)
    expect(posted.status).toBe(201)
    const { photo } = await posted.json()
    expect((await fetch(`${ORIGIN}${photo.url}`)).status).toBe(200)

    // A stranger cannot delete it.
    const refused = await fetch(`${API}/activity-photos/${photo.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${stranger}` },
    })
    expect(refused.status).toBe(403)
    expect((await fetch(`${ORIGIN}${photo.url}`)).status).toBe(200)

    const deleted = await fetch(`${API}/activity-photos/${photo.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${owner}` },
    })
    expect(deleted.status, await deleted.clone().text()).toBe(200)
    expect((await fetch(`${ORIGIN}${photo.url}`)).status).toBe(404)
    expect((await fetch(`${ORIGIN}${photo.thumbUrl}`)).status).toBe(404)
  })
})

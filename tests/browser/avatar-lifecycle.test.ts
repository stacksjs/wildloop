/**
 * A profile photo's whole life over HTTP: `POST /api/me/avatar` stores one,
 * `GET /api/avatars/{userId}/{file}` serves it, `DELETE /api/me/avatar`
 * removes it.
 *
 * Three properties here are worth holding onto, and none of them is visible to
 * a test of the functions underneath.
 *
 * The bytes decide the type, never the file name or the declared content type.
 * A file called `face.png` carrying something else must be refused, because
 * trusting the client's word about a file it uploads is how a store ends up
 * serving whatever was sent.
 *
 * Nothing of the original file is ever written. It is decoded and encoded
 * again, which leaves EXIF — including the GPS position of where the photo was
 * taken — behind. A PNG therefore comes back out as a JPEG.
 *
 * A photo stops being reachable the moment the row stops pointing at it. The
 * bucket is private and every read goes through the serving action, which
 * looks the key up against `users.avatar` — so a replaced or deleted photo
 * 404s straight away rather than staying fetchable by anyone who kept the URL.
 *
 * That last one is worth being precise about: these tests prove the stale URL
 * stops being *served*, which is the part a client can observe and the part
 * that matters for a photo someone deleted. Whether the bytes were also erased
 * from the store is not visible over HTTP, and belongs to
 * `tests/unit/avatar-storage.test.ts`.
 *
 * `tests/unit/avatars.test.ts` and `tests/unit/avatar-storage.test.ts` cover
 * the naming and the store as pure functions, and drive `writeAvatarFiles`
 * with bytes like `[1, 2, 3]` that never go near the real pipeline. This is
 * the first HTTP-level coverage.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { createSolidColor, encode } from 'ts-images'
import { API, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

const ORIGIN = 'http://127.0.0.1:4320'
/** The avatar URLs come back rooted at /api, so requests go to the host. */
const HOST = API.replace(/\/api$/, '')

const account = {
  name: 'Avatar Lifecycle QA',
  email: `avatar-lifecycle-${crypto.randomUUID()}@example.test`,
  password: `Local-QA-${crypto.randomUUID()}`,
}

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

/**
 * Both avatar routes share `throttle:20,1`, and this file spends about half
 * that budget. A second run inside the same minute would otherwise fail with a
 * 429 that looks nothing like the assertion it breaks, so the limit is waited
 * out once and the request retried. A second 429 is left to fail loudly.
 */
async function throttled(attempt: () => Promise<Response>): Promise<Response> {
  const response = await attempt()
  if (response.status !== 429)
    return response

  const retryAfter = Number((await response.clone().json().catch(() => ({}))).retryAfter ?? 1)
  await Bun.sleep(Math.min(Math.max(retryAfter, 1), 60) * 1000 + 500)
  return await attempt()
}

/** POST the multipart `avatar` field the endpoint reads. */
function upload(part: Blob | null, filename: string, token?: string): Promise<Response> {
  return throttled(async () => {
    const csrf = await csrfToken(API)
    const form = new FormData()
    if (part)
      form.append('avatar', part, filename)

    return await fetch(`${API}/me/avatar`, {
      method: 'POST',
      headers: {
        'Origin': ORIGIN,
        'X-CSRF-Token': csrf,
        'Cookie': `X-CSRF-Token=${encodeURIComponent(csrf)}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: form,
    })
  })
}

/** DELETE the avatar, under the same shared throttle as the upload. */
function destroy(token?: string): Promise<Response> {
  return throttled(() => send('/me/avatar', 'DELETE', undefined, token))
}

const bytesOf = (data: Uint8Array) => new Blob([data as unknown as BlobPart])

let bearer = ''
let userId = 0
/** A deliberately non-square PNG, so a re-encode is observable. */
let photo: Uint8Array

/** Upload a fresh photo and answer with the URL it was stored at. */
async function storeFresh(): Promise<string> {
  const response = await upload(bytesOf(photo), 'face.png', bearer)
  expect(response.status, await response.clone().text()).toBe(201)
  return (await response.json()).avatar as string
}

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()

  photo = await encode(createSolidColor(60, 30, { r: 200, g: 40, b: 40, a: 255 }), 'png')

  const registered = await send('/register', 'POST', account)
  expect(registered.status, await registered.clone().text()).toBe(200)

  const loggedIn = await send('/login', 'POST', { email: account.email, password: account.password })
  expect(loggedIn.status, await loggedIn.clone().text()).toBe(200)
  const session = await loggedIn.json()
  bearer = session.token
  userId = session.user.id
}, READY_TIMEOUT_MS + 30_000)

describe.skipIf(!qa)('avatar lifecycle', () => {
  it('stores a photo and answers with where it lives', async () => {
    const response = await upload(bytesOf(photo), 'face.png', bearer)

    expect(response.status, await response.clone().text()).toBe(201)
    const payload = await response.json()
    expect(payload.success).toBe(true)
    // Under the athlete, so one athlete's photos are never another's.
    expect(payload.avatar).toMatch(new RegExp(`^/api/avatars/${userId}/[0-9a-f-]+\\.jpg$`))
    // The profile comes back with it, so the screen needs no second request.
    expect(payload.user.avatar).toBe(payload.avatar)
  })

  it('re-encodes whatever arrives, so a PNG is stored as a JPEG', async () => {
    const url = await storeFresh()
    // A PNG went in. Nothing of the original file is kept — which is what
    // leaves the EXIF GPS position behind — so a JPEG comes out.
    expect(url.endsWith('.jpg')).toBe(true)

    const served = await fetch(`${HOST}${url}`)
    expect(served.headers.get('content-type')).toBe('image/jpeg')
    const magic = new Uint8Array((await served.arrayBuffer()).slice(0, 3))
    expect([...magic]).toEqual([0xFF, 0xD8, 0xFF])
  })

  it('serves the photo to anyone, and lets it be cached', async () => {
    const url = await storeFresh()

    // Avatars appear next to public profiles, so the file is a public read.
    const served = await fetch(`${HOST}${url}`)
    expect(served.status).toBe(200)
    expect(served.headers.get('cache-control')).toContain('public')
  })

  it('lets the bytes decide the type, not the file name', async () => {
    const notAnImage = new TextEncoder().encode('this is not an image at all')

    const response = await upload(bytesOf(notAnImage), 'sneaky.png', bearer)

    expect(response.status).toBe(422)
    const payload = await response.json()
    expect(payload.reason).toBe('unsupported-type')
    expect(payload.fields.avatar).toContain('JPEG, PNG or WebP')
  })

  it('refuses an empty file', async () => {
    const response = await upload(bytesOf(new Uint8Array(0)), 'empty.png', bearer)

    expect(response.status).toBe(422)
    expect((await response.json()).reason).toBe('empty')
  })

  it('asks for a photo when none was attached', async () => {
    const response = await upload(null, '', bearer)

    expect(response.status).toBe(422)
    // Named against the field, so the form can show it in place.
    expect((await response.json()).fields.avatar).toContain('Choose a photo')
  })

  it('stops serving the photo it replaced', async () => {
    const first = await storeFresh()
    const second = await storeFresh()
    expect(second).not.toBe(first)

    // Anyone holding the old URL — a cache, a copied link — must stop getting
    // the photo, because the row no longer points at it.
    expect((await fetch(`${HOST}${first}`)).status).toBe(404)
    expect((await fetch(`${HOST}${second}`)).status).toBe(200)
  })

  it('stops serving a photo once it is deleted', async () => {
    const url = await storeFresh()
    expect((await fetch(`${HOST}${url}`)).status).toBe(200)

    const removed = await destroy(bearer)
    expect(removed.status, await removed.clone().text()).toBe(200)
    const payload = await removed.json()
    expect(payload.avatar).toBeNull()
    expect(payload.user.avatar).toBeNull()

    // Clearing the row is what makes the photo unreachable, so this is the
    // assertion that a delete actually took effect for anyone holding the URL.
    expect((await fetch(`${HOST}${url}`)).status).toBe(404)
  })

  it('deletes an athlete who has no photo without complaining', async () => {
    // Idempotent, so the settings screen can post it from a stale view.
    const first = await destroy(bearer)
    expect(first.status).toBe(200)

    const second = await destroy(bearer)
    expect(second.status).toBe(200)
    expect((await second.json()).avatar).toBeNull()
  })

  it('answers 404 for a photo that was never stored', async () => {
    const response = await fetch(`${HOST}/api/avatars/${userId}/does-not-exist.jpg`)
    expect(response.status).toBe(404)
  })

  it('refuses to store or delete without a session', async () => {
    expect((await upload(bytesOf(photo), 'face.png')).status).toBe(401)
    expect((await destroy()).status).toBe(401)
  })
})

/** Run only against the isolated QA app (temporary SQLite, MAIL_MAILER=log). */
import { strict as assert } from 'node:assert'

const base = 'http://127.0.0.1:4321/api'
const bootstrap = await fetch(`${base}/activities`)
const cookies = bootstrap.headers.getSetCookie().map(cookie => cookie.split(';')[0])
const csrfCookie = cookies.find(cookie => cookie.startsWith('X-CSRF-Token='))
assert(csrfCookie, 'QA server did not provide the CSRF cookie')
const headers = {
  'Content-Type': 'application/json',
  Origin: 'http://127.0.0.1:4320',
  Cookie: cookies.join('; '),
  'X-CSRF-Token': decodeURIComponent(csrfCookie.slice('X-CSRF-Token='.length)),
}

async function request(path: string, method = 'GET', body?: unknown, token?: string) {
  return fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function account() {
  const email = `recording-qa-${crypto.randomUUID()}@example.test`
  // Test-only credentials; never a production mailbox or user.
  const password = `Local-QA-${crypto.randomUUID()}`
  const registered = await request('/register', 'POST', { name: 'Recording QA', email, password })
  if (!registered.ok) {
    const refusal = await registered.json() as { error?: string, message?: string }
    console.error({ status: registered.status, error: refusal.error, message: refusal.message })
  }
  assert(registered.ok, `Registration returned ${registered.status}`)
  const created = await registered.json() as { user: { id: number } }
  const login = await request('/login', 'POST', { email, password })
  assert.equal(login.status, 200, 'Fresh account login')
  const session = await login.json() as { token: string }
  assert(session.token, 'Login returned no token')
  return { id: created.user.id, token: session.token }
}

const owner = await account()
const stranger = await account()
const end = Date.now()
const coordinates = [[-118.49, 34.01], [-118.49, 34.01001], [-118.49, 34.01002]]
const payload = {
  // Deliberately spoofed: the API must bind ownership to the session.
  user_id: stranger.id,
  activity_type: 'Hike',
  distance: 0.01,
  duration: '00:40',
  moving_time: '00:35',
  visibility: 'private',
  game_mode: 'free',
  recording_source: 'web_gps',
  completed_at: new Date(end).toISOString(),
  upload_id: `qa:${crypto.randomUUID()}`,
  gpx_data: JSON.stringify({
    type: 'LineString',
    coordinates,
    properties: { samples: coordinates.map((_, index) => ({ time: end - 30000 + index * 15000, accuracy: 5, altitude: 10 })) },
  }),
}
const saved = await request('/activities', 'POST', payload, owner.token)
assert(saved.ok, `Save returned ${saved.status}`)
const savedBody = await saved.json() as { activity: { id: number, userId: number } }
assert.equal(savedBody.activity.userId, owner.id, 'Body cannot select the activity owner')
const replay = await request('/activities', 'POST', payload, owner.token)
assert(replay.ok, `Retry returned ${replay.status}`)
const replayBody = await replay.json() as { activity: { id: number } }
assert.equal(replayBody.activity.id, savedBody.activity.id, 'Retry must not create another activity')
const detail = `/activities/${savedBody.activity.id}`
const retrieved = await request(detail, 'GET', undefined, owner.token)
assert.equal(retrieved.status, 200, 'Owner retrieval')
const retrievedBody = await retrieved.json() as { activity: { route: unknown[], activityType: string, duration: string, movingTime: string } }
assert.equal(retrievedBody.activity.activityType, 'Hike')
assert.equal(retrievedBody.activity.route.length, coordinates.length, 'Stored route retrieval')
assert.equal(retrievedBody.activity.duration, '0:30', 'Elapsed time comes from timestamped GPS')
assert.equal(retrievedBody.activity.movingTime, '0:30', 'Moving time cannot exceed GPS elapsed time')
for (const [moving, expected] of [['00:12', '00:12'], ['00:00', '00:00'], [undefined, '0:30']] as const) {
  const response = await request('/activities', 'POST', { ...payload, moving_time: moving, upload_id: `qa:${crypto.randomUUID()}` }, owner.token)
  assert(response.ok, `Paused recording save returned ${response.status}`)
  const body = await response.json() as { activity: { id: number } }
  const read = await request(`/activities/${body.activity.id}`, 'GET', undefined, owner.token)
  const result = await read.json() as { activity: { movingTime: string } }
  assert.equal(result.activity.movingTime, expected, 'Preserve shorter/zero moving time and missing-time fallback')
}
assert.equal((await request(detail)).status, 403, 'Guest cannot read the private hike')
assert.equal((await request(detail, 'GET', undefined, stranger.token)).status, 403, 'Another account cannot read the private hike')
assert.equal((await request(detail, 'PATCH', { notes: 'unauthorized' }, stranger.token)).status, 403, 'Another account cannot edit the hike')
assert.equal((await request('/activities', 'POST', payload)).status, 401, 'Guest cannot create activities')
assert.equal((await request('/activities', 'POST', { ...payload, activity_type: 'invalid' }, owner.token)).status, 422, 'Malformed uploads are rejected')
console.log('PASS: fresh signup/login, saved GPS route, idempotent retry, session-bound owner, guest/other-account denials, and invalid-upload rejection. Local QA rows retained in the temporary database.')

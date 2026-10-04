import type { TrailDemand } from '../../app/Support/trailPhotoQueue'
import type { SqlTag } from '../../app/Support/trailViews'
import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { readFileSync } from 'node:fs'
import { applyApprovedTrailPhoto, approvedTrailPhotos } from '../../app/Support/approvedTrailPhotos'
import {
  COMMONS_USER_AGENT,
  CommonsRateLimited,
  fetchCommonsGeosearch,
  MAX_RETRY_WAIT_MS,
  photoDemand,
  prioritiseForPhotos,
  retryAfterMs,
  sourceTrailPhotos,
  stillIllustrative,
  storeCandidates,
  VIEWS_PER_SAVE,
} from '../../app/Support/trailPhotoQueue'
import { decidePhotoCandidate, isPhotoDecision, pendingPhotoQueue } from '../../app/Support/trailPhotoReview'

/**
 * The trail photo queue (#1006): which trails get a photograph looked for,
 * how politely Commons is asked, and the one rule everything else serves —
 * a Commons file becomes a cover only when a person approves it.
 */

const demand = (trailId: number, values: Partial<TrailDemand> = {}): TrailDemand =>
  ({ trailId, views: 0, viewDays: 0, saves: 0, completions: 0, photos: 0, reviews: 0, ...values })

const metros = [
  { name: 'Los Angeles', lat: 34.05, lng: -118.24 },
  { name: 'Denver', lat: 39.74, lng: -104.99 },
  { name: 'Berlin', lat: 52.52, lng: 13.40 },
]

describe('photoDemand', () => {
  it('is nothing for a trail nobody has touched', () => {
    expect(photoDemand(undefined)).toBe(0)
    expect(photoDemand(demand(1))).toBe(0)
  })

  it('weighs a save or a review as twenty views and a completion as forty', () => {
    expect(photoDemand(demand(1, { saves: 1 }))).toBe(VIEWS_PER_SAVE)
    expect(photoDemand(demand(1, { reviews: 1 }))).toBe(VIEWS_PER_SAVE)
    expect(photoDemand(demand(1, { completions: 1 }))).toBe(2 * VIEWS_PER_SAVE)
  })

  /* A month of steady interest beats one afternoon of a link going round. */
  it('counts views spread over days above the same views in one day', () => {
    const steady = photoDemand(demand(1, { views: 30, viewDays: 30 }))
    const spike = photoDemand(demand(2, { views: 30, viewDays: 1 }))
    expect(steady).toBe(30)
    expect(steady).toBeGreaterThan(spike)
  })
})

describe('prioritiseForPhotos', () => {
  it('puts the trails people open first, most wanted first', () => {
    const queue = prioritiseForPhotos([demand(5, { views: 4, viewDays: 4 }), demand(9, { saves: 2 }), demand(3, { views: 1, viewDays: 1 })], [], metros)
    expect(queue.map(entry => entry.trailId)).toEqual([9, 5, 3])
    expect(queue.every(entry => entry.reason === 'demand' && entry.priority > 1)).toBe(true)
  })

  it('leaves out trails with no demand and ids that are not trail ids', () => {
    const queue = prioritiseForPhotos([demand(1), demand(0, { saves: 3 }), demand(-4, { saves: 3 }), demand(7, { saves: 1 })], [], metros)
    expect(queue.map(entry => entry.trailId)).toEqual([7])
  })

  /* The first night covers the top trail of every city before the tenth of any. */
  it('takes the cities in turns after demand', () => {
    const queue = prioritiseForPhotos([], [[11, 12, 13], [21, 22], [31]], metros)
    expect(queue.map(entry => entry.trailId)).toEqual([11, 21, 31, 12, 22, 13])
    expect(queue[0].reason).toBe('near Los Angeles')
    expect(queue[1].reason).toBe('near Denver')
    expect(queue.every(entry => entry.priority < 1)).toBe(true)
    for (let i = 1; i < queue.length; i++)
      expect(queue[i].priority).toBeLessThan(queue[i - 1].priority)
  })

  it('queues a trail once, for its demand, however many lists carry it', () => {
    const queue = prioritiseForPhotos([demand(21, { saves: 1 })], [[11, 21], [21, 22]], metros)
    expect(queue.map(entry => entry.trailId)).toEqual([21, 11, 22])
    expect(queue[0].reason).toBe('demand')
  })
})

describe('stillIllustrative', () => {
  it('is true for no cover and for stock art, false for a real photograph', () => {
    expect(stillIllustrative({})).toBe(true)
    expect(stillIllustrative({ image: '  ' })).toBe(true)
    expect(stillIllustrative({ image: 'https://example.com/uploads/trail.jpg' })).toBe(false)
  })
})

describe('retryAfterMs', () => {
  it('reads seconds, caps them, and falls back on nonsense', () => {
    expect(retryAfterMs('3')).toBe(3000)
    expect(retryAfterMs('0')).toBe(0)
    expect(retryAfterMs('86400')).toBe(MAX_RETRY_WAIT_MS)
    expect(retryAfterMs(null, 1234)).toBe(1234)
    expect(retryAfterMs('', 1234)).toBe(1234)
    expect(retryAfterMs('soon', 1234)).toBe(1234)
  })

  it('reads an HTTP date as the time until then', () => {
    const later = new Date(Date.now() + 10_000).toUTCString()
    const wait = retryAfterMs(later)
    expect(wait).toBeGreaterThan(8000)
    expect(wait).toBeLessThanOrEqual(10_000)
  })
})

/** A fetch that answers from a script and remembers what it was asked. */
function scriptedFetch(...answers: Array<() => Response>) {
  const calls: Array<{ url: string, init?: RequestInit }> = []
  const send = async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const next = answers.shift()
    if (!next)
      throw new Error('no answer scripted')
    return next()
  }
  return { send, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

/** Commons' geosearch answer, as the real API shapes it. */
function commonsPage(title: string, license: string, licenseUrl = 'https://creativecommons.org/licenses/by-sa/4.0') {
  return {
    title: `File:${title}`,
    imageinfo: [{
      thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${encodeURIComponent(title)}/1280px-${encodeURIComponent(title)}`,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(title)}`,
      extmetadata: {
        LicenseShortName: { value: license },
        LicenseUrl: { value: licenseUrl },
        Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Hiker">Hiker</a>' },
      },
    }],
  }
}
const commonsPayload = (...pages: unknown[]) => ({ query: { pages: Object.fromEntries(pages.map((page, i) => [String(-1 - i), page])) } })

describe('fetchCommonsGeosearch', () => {
  it('says who we are, asks Commons to refuse us when lagged, and returns the payload', async () => {
    const { send, calls } = scriptedFetch(json({ query: { pages: {} } }))
    const sleeps: number[] = []
    const body = await fetchCommonsGeosearch(34.0, -118.5, 3000, { fetch: send, sleep: async ms => void sleeps.push(ms) })

    expect(body).toEqual({ query: { pages: {} } })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toContain('maxlag=5')
    expect(calls[0].url).toContain('ggscoord=34')
    expect((calls[0].init?.headers as Record<string, string>)['User-Agent']).toBe(COMMONS_USER_AGENT)
    expect(sleeps).toEqual([])
  })

  it('waits out one 429 for as long as Retry-After says, then carries on', async () => {
    const { send, calls } = scriptedFetch(json({}, 429, { 'Retry-After': '7' }), json({ query: { pages: {} } }))
    const sleeps: number[] = []
    await fetchCommonsGeosearch(34, -118, 3000, { fetch: send, sleep: async ms => void sleeps.push(ms) })
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([7000])
  })

  it('treats a maxlag refusal like a 429', async () => {
    const lagged = json({ error: { code: 'maxlag', info: 'Waiting for a database server' } }, 200, { 'Retry-After': '5' })
    const { send, calls } = scriptedFetch(lagged, json({ query: { pages: {} } }))
    const sleeps: number[] = []
    await fetchCommonsGeosearch(34, -118, 3000, { fetch: send, sleep: async ms => void sleeps.push(ms) })
    expect(calls).toHaveLength(2)
    expect(sleeps).toEqual([5000])
  })

  it('gives up for the night when refused twice', async () => {
    const { send, calls } = scriptedFetch(json({}, 503, { 'Retry-After': '2' }), json({}, 429, { 'Retry-After': '9' }))
    const error = await fetchCommonsGeosearch(34, -118, 3000, { fetch: send, sleep: async () => {} }).catch(e => e)
    expect(error).toBeInstanceOf(CommonsRateLimited)
    expect(error.retryAfterMs).toBe(9000)
    expect(calls).toHaveLength(2)
  })

  it('throws, without retrying, on any other failure', async () => {
    const notFound = scriptedFetch(json({}, 500))
    await expect(fetchCommonsGeosearch(34, -118, 3000, { fetch: notFound.send, sleep: async () => {} })).rejects.toThrow('Commons returned 500')
    expect(notFound.calls).toHaveLength(1)

    const bad = scriptedFetch(json({ error: { code: 'badvalue', info: 'nope' } }))
    await expect(fetchCommonsGeosearch(34, -118, 3000, { fetch: bad.send, sleep: async () => {} })).rejects.toThrow('badvalue')
  })
})

describe('the queue in a database', () => {
  let database: Database | null = null

  afterEach(() => {
    database?.close()
    database = null
  })

  /** Trails, a reviewer, and the migration as written, on an in-memory SQLite. */
  function photoDatabase(): Database {
    database = new Database(':memory:')
    database.run(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)`)
    database.run(`INSERT INTO users (id, name) VALUES (7, 'Reviewer')`)
    database.run(`CREATE TABLE trails (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, location TEXT, state TEXT, state_name TEXT, managed_by TEXT,
      latitude REAL, longitude REAL, min_lat REAL, max_lat REAL, min_lng REAL, max_lng REAL,
      distance REAL, geometry TEXT, image TEXT, source TEXT, source_id TEXT, review_count INTEGER DEFAULT 0)`)
    database.run(`INSERT INTO trails (id, name, location, state, state_name, latitude, longitude, distance, image, review_count) VALUES
      (1, 'Temescal Canyon Trail', 'Pacific Palisades', 'CA', 'California', 34.0505, -118.5302, 3.0, NULL, 4),
      (2, 'Escondido Falls Trail', 'Malibu', 'CA', 'California', 34.0399, -118.7764, 3.7, NULL, 2),
      (3, 'Mystery Loop', 'Nowhere', 'CA', 'California', NULL, NULL, 1.0, NULL, 9),
      (4, 'Runyon Canyon Loop', 'Hollywood', 'CA', 'California', 34.1106, -118.3497, 2.7, 'https://example.com/editor-chosen.jpg', 8)`)
    for (const file of ['0000000186-create-trail-view-days.sql', '0000000192-create-trail-photo-candidates.sql', '0000000197-alter-trail-photo-candidates-found-by.sql']) {
      const migration = readFileSync(new URL(`../../database/migrations/${file}`, import.meta.url), 'utf8')
      for (const statement of migration.split(';').map(part => part.trim()).filter(Boolean))
        database.run(statement)
    }
    return database
  }

  /** `db.sql` in production; the same statement and values here. */
  function sqlite(db: Database): SqlTag {
    return async (strings, ...values) => db.query(strings.join('?')).all(...(values as any[])) as any[]
  }

  const rows = (db: Database) =>
    db.query('SELECT id, trail_id, file_title, status, reason, reviewed_by FROM trail_photo_candidates ORDER BY id').all() as any[]

  const candidate = (title: string, license: string, licenseUrl = '') => ({
    title,
    url: `https://upload.wikimedia.org/${title}`,
    pageUrl: `https://commons.wikimedia.org/wiki/File:${title}`,
    credit: 'Hiker',
    license,
    licenseUrl,
    matched: ['temescal'],
  })

  it('writes usable files as pending and the rest as rejected with the reason', async () => {
    const db = photoDatabase()
    const stored = await storeCandidates(1, [
      candidate('Temescal Canyon waterfall.jpg', 'CC BY-SA 4.0'),
      candidate('Temescal Canyon ridge.jpg', 'CC BY-NC 2.0'),
      { ...candidate('Temescal insecure.jpg', 'CC BY 2.0'), url: 'http://upload.wikimedia.org/x.jpg' },
    ], 3.5, sqlite(db))

    expect(stored).toEqual({ found: 3, pending: 1, byName: 0, refused: 1 })
    const written = rows(db)
    expect(written.map(row => [row.file_title, row.status])).toEqual([
      ['Temescal Canyon waterfall.jpg', 'pending'],
      ['Temescal Canyon ridge.jpg', 'rejected'],
    ])
    expect(written[1].reason).toContain('non-commercial')
  })

  /* A rerun adds only what is new, and a person's rejection stays one. */
  it('leaves a file already on record exactly as it is', async () => {
    const db = photoDatabase()
    const sql = sqlite(db)
    await storeCandidates(1, [candidate('Temescal Canyon waterfall.jpg', 'CC BY-SA 4.0')], 1, sql)
    db.run(`UPDATE trail_photo_candidates SET status = 'rejected', reason = 'shows the beach'`)

    const again = await storeCandidates(1, [
      candidate('Temescal Canyon waterfall.jpg', 'CC BY-SA 4.0'),
      candidate('Temescal Canyon summit.jpg', 'CC0'),
    ], 1, sql)

    expect(again).toEqual({ found: 2, pending: 1, byName: 0, refused: 0 })
    expect(rows(db).map(row => [row.file_title, row.status, row.reason])).toEqual([
      ['Temescal Canyon waterfall.jpg', 'rejected', 'shows the beach'],
      ['Temescal Canyon summit.jpg', 'pending', null],
    ])
  })

  it('makes a photo a cover only once a person approves it', async () => {
    const db = photoDatabase()
    const sql = sqlite(db)
    await storeCandidates(1, [candidate('Temescal Canyon waterfall.jpg', 'CC BY-SA 4.0', 'http://creativecommons.org/licenses/by-sa/4.0')], 2, sql)

    // Pending: nothing on the trail yet, and the reviewer sees it.
    expect((await approvedTrailPhotos([1], sql)).size).toBe(0)
    const queue = await pendingPhotoQueue({}, sql)
    expect(queue.pendingTrails).toBe(1)
    expect(queue.trails[0].name).toBe('Temescal Canyon Trail')
    expect(queue.trails[0].candidates[0].licenseUrl).toBe('https://creativecommons.org/licenses/by-sa/4.0')

    const [{ id }] = rows(db)
    const result = await decidePhotoCandidate(id, 'approve', 7, { at: new Date('2026-10-04T05:00:00Z') }, sql)
    expect(result).toEqual({ ok: true, id, trailId: 1, status: 'approved' })
    expect(rows(db)[0]).toMatchObject({ status: 'approved', reviewed_by: 7 })

    const approved = await approvedTrailPhotos([1, 2], sql)
    expect([...approved.keys()]).toEqual([1])
    const cover = applyApprovedTrailPhoto({ id: 1, image: null }, approved.get(1)) as Record<string, unknown>
    expect(cover.image).toBe('https://upload.wikimedia.org/Temescal Canyon waterfall.jpg')
    expect(cover.coverCredit).toBe('Hiker')
    expect(cover.coverLicense).toBe('CC BY-SA 4.0')
    expect(cover.coverLicenseUrl).toBe('https://creativecommons.org/licenses/by-sa/4.0')
    expect(cover.coverSourceUrl).toContain('commons.wikimedia.org')

    // A trail with its cover leaves the queue.
    expect((await pendingPhotoQueue({}, sql)).pendingTrails).toBe(0)
  })

  it('never replaces an image an editor chose', () => {
    const photo = { trail_id: 4, url: 'https://upload.wikimedia.org/x.jpg', page_url: 'https://commons.wikimedia.org/wiki/File:x.jpg', credit: 'Hiker', license: 'CC0', license_url: '' }
    const trail = { id: 4, image: 'https://example.com/editor-chosen.jpg' }
    expect(applyApprovedTrailPhoto(trail, photo)).toBe(trail)
    expect(applyApprovedTrailPhoto(trail, undefined)).toBe(trail)
  })

  it('keeps one approved photo per trail: approving another sends the first back', async () => {
    const db = photoDatabase()
    const sql = sqlite(db)
    await storeCandidates(1, [candidate('Temescal A.jpg', 'CC0'), candidate('Temescal B.jpg', 'CC BY 2.0')], 1, sql)
    const [a, b] = rows(db)

    await decidePhotoCandidate(a.id, 'approve', 7, {}, sql)
    await decidePhotoCandidate(b.id, 'approve', 7, {}, sql)

    expect(rows(db).map(row => [row.file_title, row.status, row.reviewed_by])).toEqual([
      ['Temescal A.jpg', 'pending', null],
      ['Temescal B.jpg', 'approved', 7],
    ])
    expect((await approvedTrailPhotos([1], sql)).get(1)?.url).toContain('Temescal B.jpg')
  })

  it('rejects with the note, and reopens as the undo', async () => {
    const db = photoDatabase()
    const sql = sqlite(db)
    await storeCandidates(1, [candidate('Temescal A.jpg', 'CC0')], 1, sql)
    const [{ id }] = rows(db)

    await decidePhotoCandidate(id, 'approve', 7, {}, sql)
    expect(await decidePhotoCandidate(id, 'reject', 7, { note: 'a different canyon' }, sql)).toMatchObject({ ok: true, status: 'rejected' })
    expect(rows(db)[0]).toMatchObject({ status: 'rejected', reason: 'a different canyon' })
    expect((await approvedTrailPhotos([1], sql)).size).toBe(0)

    expect(await decidePhotoCandidate(id, 'reopen', 7, {}, sql)).toMatchObject({ ok: true, status: 'pending' })
    expect(rows(db)[0]).toMatchObject({ status: 'pending', reason: null, reviewed_by: null })
  })

  /* A click does not change a licence, even on a row edited by hand. */
  it('refuses to approve or reopen a photo whose licence does not allow a cover', async () => {
    const db = photoDatabase()
    const sql = sqlite(db)
    await storeCandidates(1, [candidate('Temescal NC.jpg', 'CC BY-NC-SA 2.0')], 1, sql)
    const [{ id }] = rows(db)
    db.run(`UPDATE trail_photo_candidates SET status = 'pending'`)

    const approve = await decidePhotoCandidate(id, 'approve', 7, {}, sql)
    expect(approve).toMatchObject({ ok: false, status: 422 })
    expect(await decidePhotoCandidate(id, 'reopen', 7, {}, sql)).toMatchObject({ ok: false, status: 422 })
    expect(rows(db)[0].status).toBe('pending')
    expect((await approvedTrailPhotos([1], sql)).size).toBe(0)
  })

  it('answers 404 for a candidate that is not there', async () => {
    const db = photoDatabase()
    expect(await decidePhotoCandidate(999, 'approve', 7, {}, sqlite(db))).toMatchObject({ ok: false, status: 404 })
  })

  it('knows which decisions there are', () => {
    expect(['approve', 'reject', 'reopen'].every(isPhotoDecision)).toBe(true)
    expect(isPhotoDecision('delete')).toBe(false)
    expect(isPhotoDecision(undefined)).toBe(false)
    expect(isPhotoDecision(['approve'])).toBe(false)
  })

  describe('a night of sourcing', () => {
    const at = new Date('2026-10-04T05:10:00Z')
    const answer = () => json(commonsPayload(
      commonsPage('Temescal Canyon Falls.jpg', 'CC BY-SA 4.0'),
      commonsPage('Escondido Falls Malibu.jpg', 'CC BY 2.0', 'https://creativecommons.org/licenses/by/2.0'),
      commonsPage('Temescal Canyon NC.jpg', 'CC BY-NC 2.0', 'https://creativecommons.org/licenses/by-nc/2.0'),
      commonsPage('Pinus coulteri.jpg', 'CC0'),
    ))
    /** The search by name, answering for nothing at all. */
    const nothingByName = () => json(commonsPayload())

    it('searches the wanted trails a second apart, queues what it finds, and skips them the next night', async () => {
      const db = photoDatabase()
      const sql = sqlite(db)
      const { send, calls } = scriptedFetch(answer(), nothingByName(), answer(), nothingByName())
      const sleeps: number[] = []

      const report = await sourceTrailPhotos({ sql, fetch: send, sleep: async ms => void sleeps.push(ms), metros: [], at })

      // Trail 3 has no coordinates and trail 4 has an editor's photo. Each
      // of the others is searched twice: around its head, then by name.
      expect(calls.map(call => new URL(call.url).searchParams.get('generator'))).toEqual(['geosearch', 'search', 'geosearch', 'search'])
      expect(new URL(calls[1].url).searchParams.get('gsrsearch')).toBe('intitle:"Temescal Canyon" "san fernando valley" OR California filetype:bitmap')
      expect(calls.every(call => call.url.includes('maxlag=5'))).toBe(true)
      expect(sleeps).toEqual([1000, 1000, 1000])
      expect(report).toMatchObject({ queued: 2, searched: 2, withCandidates: 2, pending: 2, byName: 0, refused: 1, failed: 0 })
      expect(rows(db).map(row => [row.trail_id, row.file_title, row.status])).toEqual([
        [1, 'Temescal Canyon Falls.jpg', 'pending'],
        [1, 'Temescal Canyon NC.jpg', 'rejected'],
        [2, 'Escondido Falls Malibu.jpg', 'pending'],
      ])
      // Nothing becomes a cover by itself.
      expect((await approvedTrailPhotos([1, 2], sql)).size).toBe(0)

      const tomorrow = await sourceTrailPhotos({ sql, fetch: send, sleep: async () => {}, metros: [], at: new Date('2026-10-05T05:10:00Z') })
      expect(tomorrow.queued).toBe(0)
      expect(calls).toHaveLength(4)
    })

    /*
     * The search by name finds what the geosearch cannot: a file with no
     * coordinates whose page says where it is, and one taken further along
     * the trail. The namesake in Riverside County is refused for distance,
     * and a file both searches found is stored once, as the nearby one.
     */
    it('queues files found by name beside the nearby ones, each once, and says which is which', async () => {
      const db = photoDatabase()
      const sql = sqlite(db)
      const located = (page: any, lat: number, lng: number) => ({ ...page, coordinates: [{ lat, lon: lng, primary: '', globe: 'earth' }] })
      const described = (page: any, description: string) => ({
        ...page,
        imageinfo: [{ ...page.imageinfo[0], extmetadata: { ...page.imageinfo[0].extmetadata, ImageDescription: { value: description } } }],
      })
      const byName = json(commonsPayload(
        located(commonsPage('Temescal Canyon waterfall, upper.jpg', 'CC BY-SA 4.0'), 34.0600, -118.5300),
        described(commonsPage('Temescal Canyon Ridge Trail.jpg', 'CC BY 2.0', 'https://creativecommons.org/licenses/by/2.0'), 'Looking down to Pacific Palisades, California'),
        located(commonsPage('Temescal Canyon Falls.jpg', 'CC BY-SA 4.0'), 34.0510, -118.5300),
        located(commonsPage('Temescal Canyon, Riverside County.jpg', 'CC BY-SA 4.0'), 33.80, -117.50),
      ))
      const { send } = scriptedFetch(answer(), byName, answer(), nothingByName())

      const report = await sourceTrailPhotos({ sql, fetch: send, sleep: async () => {}, metros: [], at })
      expect(report).toMatchObject({ searched: 2, pending: 4, byName: 2, refused: 1 })

      const written = db.query(`SELECT file_title, status, found_by, distance_m FROM trail_photo_candidates WHERE trail_id = 1 ORDER BY id`).all() as any[]
      expect(written.map(row => [row.file_title, row.status, row.found_by])).toEqual([
        ['Temescal Canyon Falls.jpg', 'pending', 'nearby'],
        ['Temescal Canyon NC.jpg', 'rejected', 'nearby'],
        ['Temescal Canyon waterfall, upper.jpg', 'pending', 'name'],
        ['Temescal Canyon Ridge Trail.jpg', 'pending', 'name'],
      ])
      expect(written[2].distance_m).toBeGreaterThan(900)
      expect(written[2].distance_m).toBeLessThan(1200)
      expect(written[3].distance_m).toBeNull()
      expect(written[0].distance_m).toBeNull()

      // The review queue says which is which, and still approves nothing.
      const page = await pendingPhotoQueue({}, sql)
      const temescal = page.trails.find(entry => entry.id === 1)!
      expect(temescal.candidates.map(c => [c.title, c.foundBy, c.distanceMetres === null])).toEqual(expect.arrayContaining([
        ['Temescal Canyon Falls.jpg', 'nearby', true],
        ['Temescal Canyon waterfall, upper.jpg', 'name', false],
        ['Temescal Canyon Ridge Trail.jpg', 'name', true],
      ]))
      expect((await approvedTrailPhotos([1, 2], sql)).size).toBe(0)
    })

    /*
     * Both searches or neither: a trail whose search by name fails is not
     * recorded, so tomorrow asks again, and what the geosearch found tonight
     * is not stored twice when it does.
     */
    it('tries a trail again tomorrow when its search by name fails', async () => {
      const db = photoDatabase()
      const sql = sqlite(db)
      const { send } = scriptedFetch(answer(), json({}, 500), answer(), nothingByName())

      const report = await sourceTrailPhotos({ sql, fetch: send, sleep: async () => {}, metros: [], at })
      expect(report).toMatchObject({ queued: 2, searched: 1, failed: 1 })
      expect(db.query('SELECT trail_id FROM trail_photo_searches').all()).toEqual([{ trail_id: 2 }])
    })

    it('stops for the night when Commons asks twice, and tries the trail again tomorrow', async () => {
      const db = photoDatabase()
      const sql = sqlite(db)
      const { send } = scriptedFetch(json({}, 429, { 'Retry-After': '1' }), json({}, 429, { 'Retry-After': '1' }))

      const report = await sourceTrailPhotos({ sql, fetch: send, sleep: async () => {}, metros: [], at })
      expect(report.stopped).toContain('slow down')
      expect(report.searched).toBe(0)
      expect(db.query('SELECT COUNT(*) AS n FROM trail_photo_searches').get()).toEqual({ n: 0 })
    })

    it('counts one failed trail and goes on to the next', async () => {
      const db = photoDatabase()
      const sql = sqlite(db)
      const { send } = scriptedFetch(json({}, 500), answer(), nothingByName())

      const report = await sourceTrailPhotos({ sql, fetch: send, sleep: async () => {}, metros: [], at })
      expect(report).toMatchObject({ queued: 2, searched: 1, failed: 1 })
      expect(db.query('SELECT trail_id FROM trail_photo_searches').all()).toHaveLength(1)
    })

    it('honours the limit', async () => {
      const db = photoDatabase()
      const { send, calls } = scriptedFetch(answer(), nothingByName())
      const report = await sourceTrailPhotos({ sql: sqlite(db), fetch: send, sleep: async () => {}, metros: [], at, limit: 1 })
      expect(report.queued).toBe(1)
      expect(calls).toHaveLength(2)
    })
  })
})

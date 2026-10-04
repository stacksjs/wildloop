import type { PhotoCandidate } from './trailPhotoCandidates'
import type { NameSearchPlan } from './trailPhotoNameSearch'
import type { RankableTrail, TrailActivity } from './trailRanking'
import type { SqlTag } from './trailViews'
import { db } from '@stacksjs/orm'
import { isStockTrailPhoto } from '../../resources/functions/stock-photos'
import { licenseVerdict } from './photoLicenses'
import { candidatesFrom, commonsGeosearchUrl } from './trailPhotoCandidates'
import { candidatesFromNameSearch, commonsNameSearchUrl, nameSearchPlan } from './trailPhotoNameSearch'
import { rankTrails, viewSignal } from './trailRanking'
import { firstViewDay, RANKED_VIEW_DAYS } from './trailViews'

/**
 * Which trails get a photograph looked for first, and the looking.
 *
 * `trailPhotoCandidates.ts` can find Commons files near a trail head whose
 * titles name the trail, and `trailPhotoNameSearch.ts` files named after it
 * that lie near it or name its park; both refuse to decide whether one shows
 * it. This is the other half: aim those searches at the trails people
 * actually open, a bounded number a night,
 * and leave what it finds as pending rows for a person to approve on
 * /admin/photos (trailPhotoReview.ts). Nothing here makes a photo a cover.
 *
 * The order:
 *
 * 1. Demand. Trail page views over the last 30 days (trailViews.ts), saves,
 *    completions and reviews. A cover is seen by everybody who opens the
 *    page, so the trails opened most are the ones a real photo improves
 *    most. Weighted the way ranking weighs them (trailRanking.ts): a save or
 *    a review is worth twenty views, a completion forty, and views count by
 *    `viewSignal`, so a month of steady interest beats one afternoon of a
 *    link going round.
 * 2. Then, while the catalog has little of that, the trails ranking would
 *    put first around the places most people live — the same "best match"
 *    a visitor in that city sees on opening the catalog. Taken a city at a
 *    time, round-robin, so the first night covers the top trail of every
 *    metro before the tenth trail of any.
 *
 * Skipped: a trail with no coordinates to search around, one already showing
 * a real photo (an upload, a curated or approved photo, an editor's image),
 * one with candidates waiting for review, and one looked up recently.
 */

/** One save or review is worth this many page views; a completion twice it. */
export const VIEWS_PER_SAVE = 20

/** How long a lookup stands before a trail is searched again for new uploads. */
export const SEARCH_REFRESH_DAYS = 90

/** Metres around a trail head to look for photographs, as the coverage report does. */
export const SEARCH_RADIUS_METRES = 3000

/** Trails searched a night unless told otherwise. Two polite requests each, about two minutes. */
export const DEFAULT_NIGHTLY_LIMIT = 60

/** At most this many candidates kept per trail: a reviewer reads them, not a crawler. */
export const MAX_CANDIDATES_PER_TRAIL = 12

/** Trails ranked around each city. Enough to fill several nights, not the box. */
export const PICKS_PER_METRO = 25

/** Miles around a city's centre that count as its trails. Ranking's own default radius. */
export const METRO_RADIUS_MILES = 25

/**
 * Commons asks every client to say who it is and how to reach them; anonymous
 * scripts are the first throttled. https://meta.wikimedia.org/wiki/User-Agent_policy
 */
export const COMMONS_USER_AGENT = 'Wildloop/1.0 (https://wildloop.org; trail photo review queue) Bun'

/** Between Commons requests. One at a time, one a second. */
export const PAUSE_MS = 1000

/** The longest a `Retry-After` is waited out before the night gives up. */
export const MAX_RETRY_WAIT_MS = 120_000

/**
 * The largest metropolitan areas the catalog covers, most populous first.
 * The US by Census MSA, then the German-speaking cities the catalog reaches.
 */
export const PHOTO_QUEUE_METROS = [
  { name: 'New York', lat: 40.7128, lng: -74.0060 },
  { name: 'Los Angeles', lat: 34.0522, lng: -118.2437 },
  { name: 'Chicago', lat: 41.8781, lng: -87.6298 },
  { name: 'Dallas', lat: 32.7767, lng: -96.7970 },
  { name: 'Houston', lat: 29.7604, lng: -95.3698 },
  { name: 'Atlanta', lat: 33.7490, lng: -84.3880 },
  { name: 'Washington', lat: 38.9072, lng: -77.0369 },
  { name: 'Philadelphia', lat: 39.9526, lng: -75.1652 },
  { name: 'Miami', lat: 25.7617, lng: -80.1918 },
  { name: 'Phoenix', lat: 33.4484, lng: -112.0740 },
  { name: 'Boston', lat: 42.3601, lng: -71.0589 },
  { name: 'San Francisco', lat: 37.7749, lng: -122.4194 },
  { name: 'Riverside', lat: 33.9806, lng: -117.3755 },
  { name: 'Detroit', lat: 42.3314, lng: -83.0458 },
  { name: 'Seattle', lat: 47.6062, lng: -122.3321 },
  { name: 'Minneapolis', lat: 44.9778, lng: -93.2650 },
  { name: 'San Diego', lat: 32.7157, lng: -117.1611 },
  { name: 'Tampa', lat: 27.9506, lng: -82.4572 },
  { name: 'Denver', lat: 39.7392, lng: -104.9903 },
  { name: 'Baltimore', lat: 39.2904, lng: -76.6122 },
  { name: 'Portland', lat: 45.5152, lng: -122.6784 },
  { name: 'Salt Lake City', lat: 40.7608, lng: -111.8910 },
  { name: 'Berlin', lat: 52.5200, lng: 13.4050 },
  { name: 'Vienna', lat: 48.2082, lng: 16.3738 },
  { name: 'Munich', lat: 48.1351, lng: 11.5820 },
  { name: 'Zurich', lat: 47.3769, lng: 8.5417 },
] as const

export interface Metro {
  name: string
  lat: number
  lng: number
}

/** What people have done with one trail. */
export interface TrailDemand extends TrailActivity {
  trailId: number
  reviews: number
}

/** Demand as one number: views by `viewSignal`, the rest by what they are worth in views. */
export function photoDemand(demand: Partial<TrailDemand> | undefined): number {
  if (!demand)
    return 0
  const people = (Number(demand.saves) || 0) + (Number(demand.reviews) || 0) + 2 * (Number(demand.completions) || 0)
  return viewSignal(demand as TrailActivity) + VIEWS_PER_SAVE * people
}

export interface QueuedTrail {
  trailId: number
  /** Higher first. Demand trails score 1 + demand; city picks fall below 1. */
  priority: number
  /** Why it is in the queue, for the log and the reviewer. */
  reason: string
}

/**
 * The order to look for photographs in: demand first, then each city's best
 * trails in turns. Pure, so the order is testable without a database.
 *
 * `metroPicks` is one ranked list per city, best first, in the order of
 * `metros`. A trail in both is queued once, for its demand.
 */
export function prioritiseForPhotos(
  demand: TrailDemand[],
  metroPicks: number[][],
  metros: readonly Metro[] = PHOTO_QUEUE_METROS,
): QueuedTrail[] {
  const queued: QueuedTrail[] = []
  const seen = new Set<number>()

  const scored = demand
    .map(row => ({ id: Number(row.trailId), score: photoDemand(row) }))
    .filter(row => Number.isSafeInteger(row.id) && row.id > 0 && row.score > 0)
    .sort((a, b) => b.score - a.score || a.id - b.id)

  for (const row of scored) {
    if (seen.has(row.id))
      continue
    seen.add(row.id)
    queued.push({ trailId: row.id, priority: 1 + row.score, reason: 'demand' })
  }

  const longest = Math.max(0, ...metroPicks.map(list => list.length))
  let turn = 0
  for (let depth = 0; depth < longest; depth++) {
    for (let city = 0; city < metroPicks.length; city++) {
      const id = Number(metroPicks[city][depth])
      if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id))
        continue
      seen.add(id)
      turn += 1
      queued.push({ trailId: id, priority: 1 / (1 + turn), reason: `near ${metros[city]?.name ?? 'a city'}` })
    }
  }

  return queued
}

const ormSql: SqlTag = async (strings, ...values) => ((await db.sql(strings, ...values).execute()) as any[]) ?? []

/**
 * Every trail somebody has looked at, saved, done or reviewed, with how much.
 *
 * Each signal is its own grouped read, capped at `cap` trails, so a night's
 * cost follows the busiest trails rather than the size of the logs.
 */
export async function trailDemand(options: { cap?: number, at?: Date } = {}, sql: SqlTag = ormSql): Promise<TrailDemand[]> {
  const cap = Math.max(1, Math.floor(Number(options.cap) || 2000))
  const since = firstViewDay(RANKED_VIEW_DAYS, options.at)
  const byTrail = new Map<number, TrailDemand>()
  const entry = (id: number): TrailDemand => {
    let value = byTrail.get(id)
    if (!value) {
      value = { trailId: id, views: 0, viewDays: 0, saves: 0, completions: 0, photos: 0, reviews: 0 }
      byTrail.set(id, value)
    }
    return value
  }

  // A signal that cannot be read costs that signal for one night.
  const [views, saves, completions, reviews] = await Promise.all([
    sql`
      SELECT trail_id, SUM(views) AS n, COUNT(*) AS days FROM trail_view_days
      WHERE day >= ${since} GROUP BY trail_id ORDER BY n DESC LIMIT ${cap}
    `.catch(() => []),
    sql`
      SELECT trail_id, COUNT(DISTINCT user_id) AS n FROM saved_trails
      WHERE is_saved = 1 OR has_visited = 1 GROUP BY trail_id ORDER BY n DESC LIMIT ${cap}
    `.catch(() => []),
    sql`
      SELECT trail_id, COUNT(DISTINCT user_id) AS n FROM activities
      WHERE trail_id IS NOT NULL GROUP BY trail_id ORDER BY n DESC LIMIT ${cap}
    `.catch(() => []),
    sql`
      SELECT id AS trail_id, review_count AS n FROM trails
      WHERE review_count > 0 ORDER BY review_count DESC LIMIT ${cap}
    `.catch(() => []),
  ]) as Array<Array<{ trail_id: number, n: number, days?: number }>>

  for (const row of views ?? []) {
    const value = entry(Number(row.trail_id))
    value.views = Number(row.n) || 0
    value.viewDays = Number(row.days) || 0
  }
  for (const row of saves ?? [])
    entry(Number(row.trail_id)).saves = Number(row.n) || 0
  for (const row of completions ?? [])
    entry(Number(row.trail_id)).completions = Number(row.n) || 0
  for (const row of reviews ?? [])
    entry(Number(row.trail_id)).reviews = Number(row.n) || 0

  return [...byTrail.values()].filter(row => Number.isSafeInteger(row.trailId) && row.trailId > 0)
}

/** Degrees of latitude per mile. Longitude is widened by 1/cos(lat). */
const DEGREES_PER_MILE = 1 / 69

/**
 * The trails ranking would show first around one city, best first.
 *
 * The same bounding box and candidate order the catalog's "near me" uses, and
 * the same `rankTrails`, so the queue reaches for the trails a visitor there
 * actually sees on their first screen.
 */
export async function metroTrailPicks(
  metro: Metro,
  options: { perMetro?: number, radiusMiles?: number, activity?: Map<number, TrailActivity> } = {},
  sql: SqlTag = ormSql,
): Promise<number[]> {
  const radius = options.radiusMiles ?? METRO_RADIUS_MILES
  const dLat = radius * DEGREES_PER_MILE
  const dLng = dLat / Math.max(0.2, Math.cos((metro.lat * Math.PI) / 180))
  const rows = await sql`
    SELECT id, name, location, source, distance, rating, review_count, national_trail, latitude, longitude, difficulty, route_type
    FROM trails
    WHERE latitude BETWEEN ${metro.lat - dLat} AND ${metro.lat + dLat}
      AND longitude BETWEEN ${metro.lng - dLng} AND ${metro.lng + dLng}
    ORDER BY browse_band ASC, rating DESC, id ASC
    LIMIT 4000
  `.catch(() => []) as RankableTrail[]

  return rankTrails(rows, metro, radius, 'best', options.activity ?? new Map())
    .slice(0, Math.max(1, options.perMetro ?? PICKS_PER_METRO))
    .map(entry => Number(entry.trail.id))
}

/** The catalog row a search needs, and what decides whether it still needs one. */
export interface SearchableTrail {
  id: number
  name: string
  state?: string | null
  latitude: number
  longitude: number
  image?: string | null
  source?: string | null
  source_id?: string | null
  /** Where it is, for the search by name: park, location, state and the box its line fills. */
  location?: string | null
  managed_by?: string | null
  state_name?: string | null
  min_lat?: number | null
  max_lat?: number | null
  min_lng?: number | null
  max_lng?: number | null
}

/**
 * Of these trails, the ones still worth a lookup tonight: placed on the map,
 * not searched within `refreshDays`, and with nothing waiting for review.
 * Returned in the order asked.
 */
export async function trailsToSearch(
  ids: number[],
  options: { refreshDays?: number, at?: Date } = {},
  sql: SqlTag = ormSql,
): Promise<SearchableTrail[]> {
  const wanted = [...new Set(ids.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))]
  if (wanted.length === 0)
    return []

  const list = JSON.stringify(wanted)
  const at = options.at ?? new Date()
  const cutoff = new Date(at.getTime() - (options.refreshDays ?? SEARCH_REFRESH_DAYS) * 86_400_000).toISOString()

  const rows = await sql`
    SELECT t.id, t.name, t.state, t.latitude, t.longitude, t.image, t.source, t.source_id,
      t.location, t.managed_by, t.state_name, t.min_lat, t.max_lat, t.min_lng, t.max_lng
    FROM trails t
    WHERE t.id IN (SELECT value FROM json_each(${list}))
      AND t.latitude IS NOT NULL AND t.longitude IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM trail_photo_searches s WHERE s.trail_id = t.id AND s.searched_at > ${cutoff})
      AND NOT EXISTS (SELECT 1 FROM trail_photo_candidates c WHERE c.trail_id = t.id AND c.status IN ('pending', 'approved'))
  ` as SearchableTrail[]

  const byId = new Map((rows ?? []).map(row => [Number(row.id), row]))
  return wanted.map(id => byId.get(id)).filter((row): row is SearchableTrail => Boolean(row))
}

/** A trail whose served cover is empty or stock still needs a photograph. */
export function stillIllustrative(trail: { image?: unknown }): boolean {
  const image = typeof trail.image === 'string' ? trail.image.trim() : ''
  return !image || isStockTrailPhoto(image)
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface CommonsClient {
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
}

export class CommonsRateLimited extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`Commons asked us to slow down (retry after ${Math.round(retryAfterMs / 1000)} s)`)
  }
}

/** Seconds from a `Retry-After` header, as milliseconds; a date or nonsense counts as `fallback`. */
export function retryAfterMs(header: string | null, fallback = 5000): number {
  // No header is not "retry now": Number(null) and Number('') are both 0.
  if (header === null || header === undefined || String(header).trim() === '')
    return fallback
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(MAX_RETRY_WAIT_MS, seconds * 1000)
  const date = Date.parse(String(header ?? ''))
  if (Number.isFinite(date))
    return Math.min(MAX_RETRY_WAIT_MS, Math.max(0, date - Date.now()))
  return fallback
}

/**
 * One Commons API request, as Commons answers it.
 *
 * `maxlag=5` asks Commons to refuse us whenever its replicas are behind,
 * which is the API's own convention for a client that can wait. A refusal for
 * lag or rate (429, 503, or a `maxlag` error) is waited out once, as long as
 * `Retry-After` says and no longer than `MAX_RETRY_WAIT_MS`; refused twice, it
 * throws `CommonsRateLimited` and the caller stops for the night.
 */
export async function fetchCommons(apiUrl: string, client: CommonsClient = {}): Promise<unknown> {
  const send = client.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init))
  const sleep = client.sleep ?? ((ms: number) => Bun.sleep(ms))
  const url = `${apiUrl}&maxlag=5`
  const init: RequestInit = {
    headers: { 'User-Agent': COMMONS_USER_AGENT, 'Api-User-Agent': COMMONS_USER_AGENT, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await send(url, init)
    const throttled = response.status === 429 || response.status === 503
    const body = throttled ? null : await response.json().catch(() => null) as any
    const lagged = body?.error?.code === 'maxlag'
    if (!throttled && !lagged) {
      if (!response.ok)
        throw new Error(`Commons returned ${response.status}`)
      if (body?.error)
        throw new Error(`Commons said ${body.error.code ?? 'error'}: ${body.error.info ?? ''}`.trim())
      return body
    }

    const wait = retryAfterMs(response.headers.get('Retry-After'))
    if (attempt === 1)
      throw new CommonsRateLimited(wait)
    await sleep(wait)
  }

  throw new CommonsRateLimited(MAX_RETRY_WAIT_MS)
}

/** The geosearch for one trail head. */
export function fetchCommonsGeosearch(lat: number, lng: number, radiusMetres: number, client: CommonsClient = {}): Promise<unknown> {
  return fetchCommons(commonsGeosearchUrl(lat, lng, radiusMetres), client)
}

/** The search for one trail's name, narrowed by its places. */
export function fetchCommonsNameSearch(plan: NameSearchPlan, client: CommonsClient = {}): Promise<unknown> {
  return fetchCommons(commonsNameSearchUrl(plan), client)
}

/**
 * One trail's candidates from both searches, each file once. The geosearch's
 * come first: a camera near the trail head is the stronger evidence, and a
 * file both searches found is the nearby one.
 */
export function mergeCandidates(nearby: PhotoCandidate[], byName: PhotoCandidate[]): PhotoCandidate[] {
  const seen = new Set<string>()
  const merged: PhotoCandidate[] = []
  for (const candidate of [...nearby, ...byName]) {
    const key = candidate.title.trim().toLowerCase()
    if (seen.has(key))
      continue
    seen.add(key)
    merged.push(candidate)
  }
  return merged
}

export interface StoredCandidates {
  /** Files whose titles name the trail. */
  found: number
  /** Of those, the ones newly written as pending for a person to look at. */
  pending: number
  /** Of the pending, the ones the search by name found. */
  byName: number
  /** Refused for their licence, written as rejected with the reason. */
  refused: number
}

/**
 * Write one trail's candidates: pending when the licence allows a cover,
 * rejected with the reason when it does not. A file already on record for
 * the trail, in any state, is left exactly as it is — a rejection stays one.
 */
export async function storeCandidates(
  trailId: number,
  candidates: PhotoCandidate[],
  priority: number,
  sql: SqlTag = ormSql,
): Promise<StoredCandidates> {
  const kept = candidates.slice(0, MAX_CANDIDATES_PER_TRAIL)
  let pending = 0
  let byName = 0
  let refused = 0
  const now = new Date().toISOString()

  for (const candidate of kept) {
    if (!candidate.url || !/^https:\/\//i.test(candidate.url) || !candidate.pageUrl)
      continue
    const verdict = licenseVerdict(candidate.license, candidate.licenseUrl)
    const status = verdict.allowed ? 'pending' : 'rejected'
    const reason = verdict.allowed ? null : verdict.reason
    const credit = candidate.credit.slice(0, 200)
    const foundBy = candidate.foundBy === 'name' ? 'name' : 'nearby'
    const distance = Number.isFinite(candidate.distanceMetres) ? Math.round(Number(candidate.distanceMetres)) : null
    const inserted = await sql`
      INSERT INTO trail_photo_candidates
        (trail_id, file_title, url, page_url, credit, license, license_url, matched_words, status, reason, priority, found_by, distance_m, created_at, updated_at)
      VALUES
        (${trailId}, ${candidate.title.slice(0, 500)}, ${candidate.url}, ${candidate.pageUrl}, ${credit}, ${candidate.license.slice(0, 100)},
         ${candidate.licenseUrl.slice(0, 500)}, ${candidate.matched.join(' ')}, ${status}, ${reason}, ${priority}, ${foundBy}, ${distance}, ${now}, ${now})
      ON CONFLICT (trail_id, file_title) DO NOTHING
      RETURNING id
    `
    // Nothing returned: the file was already on record, most likely
    // rejected by a person, and stays as it was.
    if (!inserted?.length)
      continue
    if (!verdict.allowed) {
      refused += 1
      continue
    }
    pending += 1
    if (foundBy === 'name')
      byName += 1
  }

  return { found: candidates.length, pending, byName, refused }
}

/** Remember that a trail was looked up, so the next nights skip it. */
export async function recordSearch(trailId: number, stored: StoredCandidates, priority: number, at: Date = new Date(), sql: SqlTag = ormSql): Promise<void> {
  await sql`
    INSERT INTO trail_photo_searches (trail_id, searched_at, found, accepted, priority)
    VALUES (${trailId}, ${at.toISOString()}, ${stored.found}, ${stored.pending}, ${priority})
    ON CONFLICT (trail_id) DO UPDATE SET
      searched_at = excluded.searched_at, found = excluded.found, accepted = excluded.accepted, priority = excluded.priority
  `
}

export interface SourcingReport {
  queued: number
  searched: number
  withCandidates: number
  pending: number
  /** Of the pending, the ones found by searching for a trail's name. */
  byName: number
  refused: number
  failed: number
  /** Set when Commons asked us to stop and the night ended early. */
  stopped?: string
}

export interface SourcingOptions extends CommonsClient {
  limit?: number
  radiusMetres?: number
  metros?: readonly Metro[]
  perMetro?: number
  refreshDays?: number
  at?: Date
  sql?: SqlTag
  /** What a visitor is served for these trails; `withBestTrailCovers` in production. */
  servedCovers?: (rows: SearchableTrail[]) => Promise<Array<{ id: number, image?: unknown }>>
  /** One line per trail, for the command's output. */
  onTrail?: (trail: SearchableTrail, queued: QueuedTrail, stored: StoredCandidates | null, error?: string) => void
}

/**
 * One night's sourcing: build the queue, look up the first `limit` trails it
 * still holds, and store what Commons offers for each, one request at a time:
 * the geosearch around the head, then — when the name is distinctive enough
 * to search for — the search by name.
 */
export async function sourceTrailPhotos(options: SourcingOptions = {}): Promise<SourcingReport> {
  const sql = options.sql ?? ormSql
  const limit = Math.max(1, Math.floor(Number(options.limit) || DEFAULT_NIGHTLY_LIMIT))
  const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms))
  const metros = options.metros ?? PHOTO_QUEUE_METROS
  const report: SourcingReport = { queued: 0, searched: 0, withCandidates: 0, pending: 0, byName: 0, refused: 0, failed: 0 }

  const demand = await trailDemand({ at: options.at }, sql)
  const activity = new Map<number, TrailActivity>(demand.map(row => [row.trailId, row]))

  /*
   * Cities are ranked only when demand leaves room tonight, and then all of
   * them, so the turns are taken across every city rather than the first few
   * on the list. Eligibility is read once per trail however the queue is
   * reordered by the cities joining it.
   */
  const known = new Map<number, SearchableTrail | null>()
  let eligible = await eligibleInOrder(prioritiseForPhotos(demand, [], metros), known, options, sql)
  if (eligible.length < limit) {
    const picks: number[][] = []
    for (const metro of metros)
      picks.push(await metroTrailPicks(metro, { perMetro: options.perMetro, activity }, sql))
    eligible = await eligibleInOrder(prioritiseForPhotos(demand, picks, metros), known, options, sql)
  }

  const tonight = eligible.slice(0, limit)
  report.queued = tonight.length

  for (const [index, { trail, queued }] of tonight.entries()) {
    if (index > 0)
      await sleep(PAUSE_MS)

    let stored: StoredCandidates
    try {
      const nearby = candidatesFrom(
        await fetchCommonsGeosearch(Number(trail.latitude), Number(trail.longitude), options.radiusMetres ?? SEARCH_RADIUS_METRES, options),
        trail.name,
      )
      const plan = nameSearchPlan(trail)
      let byName: PhotoCandidate[] = []
      if (plan) {
        await sleep(PAUSE_MS)
        byName = candidatesFromNameSearch(await fetchCommonsNameSearch(plan, options), trail, plan)
      }
      // Both searches or neither: a trail is recorded as searched only once
      // both have answered, so a failure in the second retries the first
      // tomorrow too, and the unique index keeps that from doubling anything.
      stored = await storeCandidates(trail.id, mergeCandidates(nearby, byName), queued.priority, sql)
    }
    catch (error) {
      if (error instanceof CommonsRateLimited) {
        report.stopped = error.message
        break
      }
      // One trail failing is not the night failing. Not recorded as searched,
      // so tomorrow tries it again.
      report.failed += 1
      options.onTrail?.(trail, queued, null, error instanceof Error ? error.message : 'search failed')
      continue
    }

    await recordSearch(trail.id, stored, queued.priority, options.at, sql)
    report.searched += 1
    report.pending += stored.pending
    report.byName += stored.byName
    report.refused += stored.refused
    if (stored.pending > 0)
      report.withCandidates += 1
    options.onTrail?.(trail, queued, stored)
  }

  return report
}

/**
 * The queued trails still worth a lookup, in queue order. Read in slices so
 * a long demand list costs a few indexed reads, and judged on the cover a
 * visitor is actually served, which is applied on read and not stored.
 * `known` remembers each trail's answer across calls.
 */
async function eligibleInOrder(
  queue: QueuedTrail[],
  known: Map<number, SearchableTrail | null>,
  options: SourcingOptions,
  sql: SqlTag,
): Promise<Array<{ trail: SearchableTrail, queued: QueuedTrail }>> {
  const served = options.servedCovers ?? (async (rows: SearchableTrail[]) => rows)
  const unknown = queue.map(entry => entry.trailId).filter(id => !known.has(id))

  for (let start = 0; start < unknown.length; start += 500) {
    const slice = unknown.slice(start, start + 500)
    const rows = await trailsToSearch(slice, options, sql)
    const covered = await served(rows.map(row => ({ ...row })))
    const illustrative = new Set(covered.filter(stillIllustrative).map(row => Number(row.id)))
    for (const id of slice)
      known.set(id, null)
    for (const row of rows) {
      if (illustrative.has(Number(row.id)))
        known.set(Number(row.id), row)
    }
  }

  return queue
    .map(queued => ({ trail: known.get(queued.trailId) ?? null, queued }))
    .filter((entry): entry is { trail: SearchableTrail, queued: QueuedTrail } => entry.trail !== null)
}

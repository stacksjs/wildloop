import { log } from '@stacksjs/logging'
import { db } from '@stacksjs/orm'

/**
 * Trail page views, counted as a popularity signal and nothing more.
 *
 * Saves, completions and photos are what ranking would like to read, and
 * almost nobody has made any yet. Looking at a trail is the weakest kind of
 * interest there is, but it is the one there is plenty of, and it is how a
 * trail app knows which trails people are actually curious about before they
 * have walked them.
 *
 * What counts as one view: the trail page, opened in a browser that ran its
 * script, says so once with `POST /api/trails/{id}/view`. Not the HTML
 * request and not the API read, because neither is a person looking:
 *
 * - The HTML of 600,000 trail pages is what crawlers, link-preview scrapers,
 *   uptime checks and link prefetching ask for, far more often than people
 *   do. None of those run the page script.
 * - `GET /api/trails/{id}` is skipped when the trail is already in the
 *   client store (arriving from a list), and other screens call it too. It
 *   would undercount and double count at once.
 *
 * A POST is never prefetched or cached, and the page sends one per visit.
 * What is left to throw away is decided here:
 *
 * - Bots: anything whose User-Agent says it is one, or does not claim to be
 *   a browser at all (scripts, HTTP libraries, headless browsers).
 * - Prefetch and prerender: a page loaded speculatively runs its script
 *   before anybody looks at it, and Chrome marks those requests.
 * - Another site: a page elsewhere cannot spend its visitors on our counts.
 *   The browser says where a request came from, so the CSRF cookie is not
 *   needed for that, and the first page of a first visit, before any cookie
 *   has been set, still counts.
 * - The same visitor again within a few hours: a reload, the back button, a
 *   second look before setting out.
 *
 * Telling one visitor from another needs to know who they are, and nothing
 * here stores that. A visitor is a hash of their address and browser with a
 * secret that exists only in this process, kept in memory until the window
 * passes. A restart forgets everyone, which costs at most a duplicate. The
 * table holds one number per trail per day (migration 0000000186).
 */

/** How long the same visitor looking again is the same view. */
export const VIEW_WINDOW_MS = 6 * 60 * 60 * 1000

/**
 * Visitors remembered at once. At the cap the oldest is forgotten first, so
 * a flood costs some duplicates rather than the server's memory.
 */
export const MAX_REMEMBERED_VISITORS = 100_000

/**
 * Views one trail can gain in one day. Far above what any trail sees from
 * people, and the most a script cycling through browsers can add to one.
 */
export const DAILY_VIEW_CAP = 500

/** Days of views ranking reads. */
export const RANKED_VIEW_DAYS = 30

/** Days of views kept at all. Ranking reads 30, the rest is for looking back. */
export const KEPT_VIEW_DAYS = 120

export type ViewVerdict =
  | { counted: true }
  | { counted: false, reason: 'bot' | 'prefetch' | 'cross-site' | 'repeat' }

/**
 * Crawlers, scrapers, monitors and tools, by what their User-Agent says.
 *
 * Most say "bot", "crawl" or "spider" and the rest are named. Matched
 * case-insensitively anywhere in the string.
 */
const BOT_AGENT = new RegExp([
  'bot\\b', 'bot/', 'crawl', 'spider', 'slurp', 'scrap', 'fetch', 'archiver', 'preview',
  'headless', 'phantomjs', 'selenium', 'puppeteer', 'playwright', 'lighthouse', 'pagespeed',
  'facebookexternalhit', 'meta-externalagent', 'embedly', 'whatsapp', 'skypeuripreview',
  'pingdom', 'uptime', 'statuscake', 'monitor', 'datadog', 'newrelic', 'checkly',
  'google-inspectiontool', 'google-read-aloud', 'mediapartners', 'adsbot', 'feedfetcher',
  'python', 'curl', 'wget', 'httpclient', 'http-client', 'okhttp', 'axios', 'node-fetch',
  'undici', 'go-http', 'java/', 'libwww', 'perl', 'ruby', 'postman', 'insomnia', 'bun/',
  'gptbot', 'chatgpt', 'claude', 'anthropic', 'perplexity', 'ccbot', 'bytespider', 'amazonbot',
].join('|'), 'i')

/**
 * Whether a User-Agent is something other than a person's browser.
 *
 * Every browser in use, and the in-app web views, still begins with
 * "Mozilla/". A client that does not is a script, and an empty one is not
 * even trying.
 */
export function isLikelyBot(userAgent: string | null | undefined): boolean {
  const agent = String(userAgent ?? '').trim()
  if (!agent || !agent.startsWith('Mozilla/'))
    return true
  return BOT_AGENT.test(agent.replace(PHONES_NAMED_BOT, ''))
}

/**
 * Phone makers whose model names end in "bot", which `bot\b` would otherwise
 * read as a crawler: "Android 10; CUBOT X30". Taken out of the string before
 * matching rather than loosening `bot\b`, which is what catches Googlebot.
 */
const PHONES_NAMED_BOT = /\bcubot\b/gi

type HeaderSource = Headers | Record<string, string | undefined> | null | undefined

function header(headers: HeaderSource, name: string): string {
  if (!headers)
    return ''
  const raw = typeof (headers as Headers).get === 'function'
    ? (headers as Headers).get(name)
    : ((headers as Record<string, string | undefined>)[name] ?? (headers as Record<string, string | undefined>)[name.toLowerCase()])
  return typeof raw === 'string' ? raw.trim() : ''
}

/** A request made for a page nobody is looking at yet. */
export function isPrefetch(headers: HeaderSource): boolean {
  const purpose = [header(headers, 'sec-purpose'), header(headers, 'purpose'), header(headers, 'x-purpose'), header(headers, 'x-moz')]
    .join(' ')
    .toLowerCase()
  return purpose.includes('prefetch') || purpose.includes('prerender') || purpose.includes('preview')
}

/**
 * A request another site made from its visitor's browser. Browsers send
 * `Sec-Fetch-Site` with every fetch; a client that sends none is judged on
 * its User-Agent alone.
 */
export function isCrossSite(headers: HeaderSource): boolean {
  return header(headers, 'sec-fetch-site').toLowerCase() === 'cross-site'
}

/** The address a request came from, as the edge reports it. Only ever hashed. */
export function visitorAddress(headers: HeaderSource): string {
  return header(headers, 'cf-connecting-ip')
    || header(headers, 'x-real-ip')
    || header(headers, 'x-forwarded-for').split(',')[0].trim()
}

/**
 * Who has looked at which trail recently, as hashes that mean nothing
 * outside this process.
 *
 * Insertion order is expiry order, since every entry lives the same window,
 * so forgetting the expired ones is a walk from the front that stops at the
 * first one still current.
 */
export class RecentViews {
  private readonly seen = new Map<bigint | number, number>()
  private readonly seed = crypto.getRandomValues(new BigUint64Array(1))[0]

  constructor(
    private readonly windowMs = VIEW_WINDOW_MS,
    private readonly capacity = MAX_REMEMBERED_VISITORS,
    private readonly now: () => number = Date.now,
  ) {}

  get size(): number {
    return this.seen.size
  }

  /** True when this visitor looked at this trail within the window. Remembers them either way. */
  repeat(trailId: number, address: string, userAgent: string): boolean {
    const now = this.now()
    for (const [key, expires] of this.seen) {
      if (expires > now)
        break
      this.seen.delete(key)
    }

    const key = Bun.hash(`${trailId}\u0000${address}\u0000${userAgent}`, this.seed)
    const expires = this.seen.get(key)
    if (expires !== undefined && expires > now)
      return true

    while (this.seen.size >= this.capacity) {
      const oldest = this.seen.keys().next().value
      if (oldest === undefined)
        break
      this.seen.delete(oldest)
    }
    this.seen.set(key, now + this.windowMs)
    return false
  }
}

/**
 * Whether a request is one person looking at one trail. Cheap checks first:
 * a bot never reaches the visitor memory, so crawling cannot fill it.
 */
export function judgeView(headers: HeaderSource, trailId: number, recent: RecentViews): ViewVerdict {
  const userAgent = header(headers, 'user-agent')
  if (isLikelyBot(userAgent))
    return { counted: false, reason: 'bot' }
  if (isPrefetch(headers))
    return { counted: false, reason: 'prefetch' }
  if (isCrossSite(headers))
    return { counted: false, reason: 'cross-site' }
  if (recent.repeat(trailId, visitorAddress(headers), userAgent))
    return { counted: false, reason: 'repeat' }
  return { counted: true }
}

/** The day a view is counted on, in UTC. */
export function viewDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10)
}

/** The first day a window of `days` days ending on `at` includes. */
export function firstViewDay(days: number, at: Date = new Date()): string {
  return viewDay(new Date(at.getTime() - (days - 1) * 86_400_000))
}

/** One process, one memory of who has looked at what. */
export const recentTrailViews = new RecentViews()

/**
 * Runs a tagged SQL template with its values bound. The ORM's `db.sql` here;
 * the unit tests pass the same statements to an in-memory SQLite.
 */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>

const ormSql: SqlTag = async (strings, ...values) => ((await db.sql(strings, ...values).execute()) as any[]) ?? []

/**
 * Add one view to a trail's count for the day.
 *
 * One upsert on the primary key, guarded by the trail existing, so an id
 * that names no trail writes nothing. Stops at `DAILY_VIEW_CAP`. Never
 * throws: the caller does not wait for it, and a count that could not be
 * written is a lost view, logged, and nothing else.
 */
export async function countTrailView(trailId: number, day: string = viewDay(), sql: SqlTag = ormSql): Promise<void> {
  try {
    await sql`
      INSERT INTO trail_view_days (trail_id, day, views)
      SELECT ${trailId}, ${day}, 1
      WHERE EXISTS (SELECT 1 FROM trails WHERE id = ${trailId})
      ON CONFLICT (trail_id, day) DO UPDATE SET views = views + 1
      WHERE views < ${DAILY_VIEW_CAP}
    `
  }
  catch (error) {
    log.warn(`[trails] could not count a view of trail ${trailId}: ${error instanceof Error ? error.message : error}`)
  }
}

export interface PruneReport {
  removed: number
  /** True when the night stopped at its batch limit with old rows left. */
  more: boolean
}

/**
 * Remove view days older than anything is kept for, a batch at a time.
 *
 * Bounded so the nightly run takes the write lock in short turns and stops
 * after `maxBatches`; whatever is left goes the next night. Keyed on the day
 * index, so each batch reads only what it removes.
 */
export async function pruneTrailViews(
  options: { keepDays?: number, batch?: number, maxBatches?: number, at?: Date } = {},
  sql: SqlTag = ormSql,
): Promise<PruneReport> {
  const whole = (value: number | undefined, fallback: number) => Math.max(1, Math.floor(Number(value) || fallback))
  const before = firstViewDay(whole(options.keepDays, KEPT_VIEW_DAYS), options.at)
  const batch = whole(options.batch, 5000)
  const maxBatches = whole(options.maxBatches, 50)

  // Counted before each delete rather than read off the delete, whose result
  // says nothing about how many rows it touched.
  const oldDays = async (): Promise<number> => {
    const [row] = await sql`
      SELECT COUNT(*) AS n FROM (SELECT 1 FROM trail_view_days WHERE day < ${before} LIMIT ${batch})
    `
    return Number(row?.n) || 0
  }

  let removed = 0
  for (let round = 0; round < maxBatches; round++) {
    const found = await oldDays()
    if (found === 0)
      return { removed, more: false }
    await sql`
      DELETE FROM trail_view_days
      WHERE (trail_id, day) IN (
        SELECT trail_id, day FROM trail_view_days WHERE day < ${before} LIMIT ${batch}
      )
    `
    removed += found
  }

  return { removed, more: await oldDays() > 0 }
}

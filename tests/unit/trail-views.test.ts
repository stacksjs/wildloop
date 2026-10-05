import type { SqlTag } from '../../app/Support/trailViews'
import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  countTrailView,
  DAILY_VIEW_CAP,
  firstViewDay,
  isLikelyBot,
  isPrefetch,
  judgeView,
  pruneTrailViews,
  RecentViews,
  viewDay,
} from '../../app/Support/trailViews'

/**
 * What counts as somebody looking at a trail (app/Support/trailViews.ts):
 * one browser, once in a few hours, never a crawler or a prefetch, and
 * nobody remembered past that.
 */

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0'

describe('who is a person', () => {
  it('lets browsers through', () => {
    for (const agent of [CHROME, IPHONE, ANDROID, FIREFOX])
      expect(isLikelyBot(agent)).toBe(false)
  })

  it('does not take a phone whose model ends in "bot" for a crawler', () => {
    const cubot = 'Mozilla/5.0 (Linux; Android 10; CUBOT X30) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36'
    expect(isLikelyBot(cubot)).toBe(false)
    // While the rule that catches it still catches the crawlers it is for.
    expect(isLikelyBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toBe(true)
  })

  it('turns away crawlers, previewers and monitors that say what they are', () => {
    for (const agent of [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116.0.1938.76 Safari/537.36',
      'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.6668.89 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/129.0.0.0 Safari/537.36',
      'Mozilla/5.0 (compatible; Pingdom.com_bot_version_1.4)',
      'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)',
      `${CHROME} Lighthouse`,
    ])
      expect(isLikelyBot(agent), agent).toBe(true)
  })

  it('turns away anything that does not claim to be a browser at all', () => {
    for (const agent of ['facebookexternalhit/1.1', 'Slackbot-LinkExpanding 1.0', 'curl/8.7.1', 'python-requests/2.32.3', 'Bun/1.3.0', 'okhttp/4.12.0', '', null, undefined])
      expect(isLikelyBot(agent), String(agent)).toBe(true)
  })

  it('knows a prefetch or a prerender', () => {
    expect(isPrefetch({ 'sec-purpose': 'prefetch' })).toBe(true)
    expect(isPrefetch({ 'sec-purpose': 'prefetch;prerender' })).toBe(true)
    expect(isPrefetch({ purpose: 'prefetch' })).toBe(true)
    expect(isPrefetch(new Headers({ 'X-Moz': 'prefetch' }))).toBe(true)
    expect(isPrefetch({ 'user-agent': CHROME })).toBe(false)
    expect(isPrefetch(null)).toBe(false)
  })
})

describe('one view per visitor', () => {
  const HOUR = 60 * 60 * 1000
  let clock = Date.parse('2026-10-04T12:00:00Z')
  const tick = () => clock
  const post = (headers: Record<string, string>) => new Request('http://localhost/api/trails/7/view', { method: 'POST', headers })
  const visit = (agent: string, address = '203.0.113.7', extra: Record<string, string> = {}) =>
    post({ 'user-agent': agent, 'x-forwarded-for': `${address}, 10.0.0.1`, 'sec-fetch-site': 'same-origin', ...extra })

  afterEach(() => {
    clock = Date.parse('2026-10-04T12:00:00Z')
  })

  it('counts the first look and not a reload', () => {
    const recent = new RecentViews(6 * HOUR, 1000, tick)
    expect(judgeView(visit(CHROME), 7, recent)).toEqual({ counted: true })
    expect(judgeView(visit(CHROME), 7, recent)).toEqual({ counted: false, reason: 'repeat' })
    clock += 5 * HOUR
    expect(judgeView(visit(CHROME), 7, recent)).toEqual({ counted: false, reason: 'repeat' })
  })

  it('counts the same visitor again once the window has passed', () => {
    const recent = new RecentViews(6 * HOUR, 1000, tick)
    expect(judgeView(visit(CHROME), 7, recent).counted).toBe(true)
    clock += 6 * HOUR + 1
    expect(judgeView(visit(CHROME), 7, recent).counted).toBe(true)
    // And forgets the old entry rather than keeping it beside the new one.
    expect(recent.size).toBe(1)
  })

  it('tells trails, browsers and addresses apart', () => {
    const recent = new RecentViews(6 * HOUR, 1000, tick)
    expect(judgeView(visit(CHROME), 7, recent).counted).toBe(true)
    expect(judgeView(visit(CHROME), 8, recent).counted).toBe(true)
    expect(judgeView(visit(IPHONE), 7, recent).counted).toBe(true)
    expect(judgeView(visit(CHROME, '198.51.100.4'), 7, recent).counted).toBe(true)
    expect(recent.size).toBe(4)
  })

  it('reads the address the edge reports', () => {
    const recent = new RecentViews(6 * HOUR, 1000, tick)
    // rpx names the Cloudflare edge that connected; Cloudflare names the visitor.
    const behind = (address: string) => post({ 'user-agent': CHROME, 'cf-connecting-ip': address, 'x-forwarded-for': '172.70.1.9' })
    expect(judgeView(behind('203.0.113.7'), 7, recent).counted).toBe(true)
    expect(judgeView(behind('203.0.113.8'), 7, recent).counted).toBe(true)
    expect(judgeView(behind('203.0.113.7'), 7, recent).counted).toBe(false)
  })

  it('is not a new visitor for naming a new address', () => {
    // Reaching the origin directly, a client writes whatever headers it likes.
    // Only the hop the proxy in front of us appended says who it is.
    const recent = new RecentViews(6 * HOUR, 1000, tick)
    const direct = (claimed: string) => post({ 'user-agent': CHROME, 'cf-connecting-ip': claimed, 'x-forwarded-for': `${claimed}, 198.51.100.9` })
    expect(judgeView(direct('203.0.113.7'), 7, recent).counted).toBe(true)
    expect(judgeView(direct('203.0.113.8'), 7, recent)).toEqual({ counted: false, reason: 'repeat' })
  })

  it('never counts, or remembers, a bot', () => {
    const recent = new RecentViews(6 * HOUR, 1000, tick)
    for (let i = 0; i < 5; i++)
      expect(judgeView(visit('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 7, recent)).toEqual({ counted: false, reason: 'bot' })
    expect(recent.size).toBe(0)
  })

  it('does not count a prefetch, or another site spending its visitors', () => {
    const recent = new RecentViews(6 * HOUR, 1000, tick)
    expect(judgeView(visit(CHROME, undefined, { 'sec-purpose': 'prefetch;prerender' }), 7, recent)).toEqual({ counted: false, reason: 'prefetch' })
    expect(judgeView(visit(CHROME, undefined, { 'sec-fetch-site': 'cross-site' }), 7, recent)).toEqual({ counted: false, reason: 'cross-site' })
    // Neither used up the real visit.
    expect(judgeView(visit(CHROME), 7, recent)).toEqual({ counted: true })
    // A client that says nothing about where it was sent from is judged on
    // its User-Agent.
    expect(judgeView(post({ 'user-agent': IPHONE }), 7, recent)).toEqual({ counted: true })
  })

  it('forgets the oldest visitor first when full, rather than growing', () => {
    const recent = new RecentViews(6 * HOUR, 3, tick)
    for (const trailId of [1, 2, 3, 4])
      expect(judgeView(visit(CHROME), trailId, recent).counted).toBe(true)
    expect(recent.size).toBe(3)
    // Trail 1 was forgotten, so it counts again; trail 4 was not.
    expect(judgeView(visit(CHROME), 4, recent).counted).toBe(false)
    expect(judgeView(visit(CHROME), 1, recent).counted).toBe(true)
  })

  it('keeps no address or browser in what it remembers', () => {
    const recent = new RecentViews(6 * HOUR, 1000, tick)
    judgeView(visit(CHROME, '203.0.113.7'), 7, recent)
    const remembered = JSON.stringify([...(recent as any).seen.keys()].map(String))
    expect(remembered).not.toContain('203.0.113.7')
    expect(remembered).not.toContain('Chrome')
  })
})

describe('the day a view lands on', () => {
  it('is the UTC date', () => {
    expect(viewDay(new Date('2026-10-04T23:59:59Z'))).toBe('2026-10-04')
    expect(viewDay(new Date('2026-10-05T00:00:00Z'))).toBe('2026-10-05')
  })

  it('opens a window that includes today', () => {
    const at = new Date('2026-10-04T08:00:00Z')
    expect(firstViewDay(1, at)).toBe('2026-10-04')
    expect(firstViewDay(30, at)).toBe('2026-09-05')
  })
})

describe('the daily count', () => {
  let database: Database | null = null

  afterEach(() => {
    database?.close()
    database = null
  })

  /** The migration as written, on an in-memory SQLite with a trails table. */
  function viewsDatabase(): Database {
    database = new Database(':memory:')
    database.run('CREATE TABLE trails (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)')
    database.run(`INSERT INTO trails (id, name) VALUES (1, 'Temescal Canyon Trail'), (2, 'Escondido Falls Trail')`)
    const migration = readFileSync(new URL('../../database/migrations/0000000186-create-trail-view-days.sql', import.meta.url), 'utf8')
    for (const statement of migration.split(';').map(part => part.trim()).filter(Boolean))
      database.run(statement)
    return database
  }

  /** `db.sql` in production; the same statement and values here. */
  function sqlite(db: Database): SqlTag & { statements: number } {
    const run = async (strings: TemplateStringsArray, ...values: unknown[]) => {
      run.statements++
      return db.query(strings.join('?')).all(...(values as any[])) as any[]
    }
    run.statements = 0
    return run
  }

  const views = (db: Database) => db.query('SELECT trail_id, day, views FROM trail_view_days ORDER BY trail_id, day').all()

  it('adds one view per call to the day row, in one statement', async () => {
    const db = viewsDatabase()
    const sql = sqlite(db)
    await countTrailView(1, '2026-10-04', sql)
    await countTrailView(1, '2026-10-04', sql)
    await countTrailView(1, '2026-10-05', sql)
    await countTrailView(2, '2026-10-04', sql)
    expect(views(db)).toEqual([
      { trail_id: 1, day: '2026-10-04', views: 2 },
      { trail_id: 1, day: '2026-10-05', views: 1 },
      { trail_id: 2, day: '2026-10-04', views: 1 },
    ])
    expect(sql.statements).toBe(4)
  })

  it('writes nothing for a trail that does not exist', async () => {
    const db = viewsDatabase()
    await countTrailView(999, '2026-10-04', sqlite(db))
    expect(views(db)).toEqual([])
  })

  it('stops at the daily cap', async () => {
    const db = viewsDatabase()
    db.run(`INSERT INTO trail_view_days (trail_id, day, views) VALUES (1, '2026-10-04', ${DAILY_VIEW_CAP - 1})`)
    await countTrailView(1, '2026-10-04', sqlite(db))
    await countTrailView(1, '2026-10-04', sqlite(db))
    expect(views(db)).toEqual([{ trail_id: 1, day: '2026-10-04', views: DAILY_VIEW_CAP }])
  })

  it('never throws when the write fails', async () => {
    const broken: SqlTag = async () => {
      throw new Error('database is locked')
    }
    await expect(countTrailView(1, '2026-10-04', broken)).resolves.toBeUndefined()
  })

  it('prunes days past the window, a bounded batch at a time', async () => {
    const db = viewsDatabase()
    const at = new Date('2026-10-04T04:40:00Z')
    const insert = db.query('INSERT INTO trail_view_days (trail_id, day, views) VALUES (?, ?, 3)')
    for (let daysAgo = 0; daysAgo < 200; daysAgo++) {
      insert.run(1, viewDay(new Date(at.getTime() - daysAgo * 86_400_000)))
      insert.run(2, viewDay(new Date(at.getTime() - daysAgo * 86_400_000)))
    }

    // 80 days on each of two trails are past 120 days: 160 rows. Two
    // batches of 50 is not enough, and says so.
    const first = await pruneTrailViews({ keepDays: 120, batch: 50, maxBatches: 2, at }, sqlite(db))
    expect(first).toEqual({ removed: 100, more: true })

    const rest = await pruneTrailViews({ keepDays: 120, batch: 50, maxBatches: 10, at }, sqlite(db))
    expect(rest).toEqual({ removed: 60, more: false })

    const left = db.query('SELECT COUNT(*) AS n, MIN(day) AS oldest FROM trail_view_days').get() as { n: number, oldest: string }
    expect(left).toEqual({ n: 240, oldest: firstViewDay(120, at) })

    // Nothing left to do costs one count.
    const sql = sqlite(db)
    expect(await pruneTrailViews({ keepDays: 120, at }, sql)).toEqual({ removed: 0, more: false })
    expect(sql.statements).toBe(1)
  })
})

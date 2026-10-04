import type { Database } from 'bun:sqlite'
import type { PageParams } from '../../resources/functions/pagination'
import { afterEach, describe, expect, it } from 'bun:test'
import { athleteCountSql, athletePageSql, searchAthletes } from '../../app/Support/athleteSearch'
import { athletesLivingNear, type Origin } from '../../app/Support/athletesNear'
import { avatarOf } from '../../app/Support/avatars'
import { paginate } from '../../resources/functions/pagination'
import { seeded } from '../fixtures/clubDatabase'
import {
  type ActivityRowFixture,
  blockedFor,
  directoryDatabase,
  insertActivities,
  insertBlocks,
  insertFollows,
  insertUsers,
  planOf,
  runner,
  type UserFixture,
} from '../fixtures/directoryDatabase'

/**
 * `GET /api/users/search` counts, orders and pages in SQL now. It used to load
 * every user and every activity they had recorded, tracks and all, and do it
 * in memory. That version is kept below as the reference: the same tables go
 * to both, and every page has to come out the same for every viewer, query
 * and place.
 *
 * Near-ness is the gazetteer's answer in the app. Here it is a small table of
 * towns, handed to both sides, since what is under test is how the answer is
 * used rather than the gazetteer.
 */

const TOWNS: Record<string, Origin> = {
  'Denver, CO': { lat: 39.74, lng: -104.98 },
  'Boulder, CO': { lat: 40.01, lng: -105.27 },
  'San Diego, CA': { lat: 32.72, lng: -117.16 },
}
const DENVER: Origin = { lat: 39.74, lng: -104.98 }
const SAN_DIEGO: Origin = { lat: 32.72, lng: -117.16 }

/** Within a degree or so: Boulder is near Denver, San Diego is not. */
function nearTown(location: unknown, origin: Origin): boolean {
  const town = TOWNS[String(location ?? '')]
  return !!town && Math.hypot(town.lat - origin.lat, town.lng - origin.lng) < 1
}

let database: Database | null = null

afterEach(() => {
  database?.close()
  database = null
})

function open(): Database {
  database = directoryDatabase()
  return database
}

interface Ask {
  viewer: number | null
  q: string
  from: Origin | null
  page: PageParams
}

/** What the action does now, minus the HTTP. */
async function fromSql(db: Database, ask: Ask) {
  const run = runner(db)
  const from = ask.q.length >= 2 ? null : ask.from
  const near = from ? await athletesLivingNear(run, from, nearTown) : null
  return await searchAthletes(run, { text: ask.q, blocked: blockedFor(db, ask.viewer), near, page: ask.page })
}

/** The action as it was, reading whole tables. */
function inMemory(db: Database, ask: Ask) {
  const q = ask.q
  const blockedIds = blockedFor(db, ask.viewer)
  const users = q.length >= 2
    ? db.query('SELECT * FROM users WHERE name LIKE ?').all(`%${q}%`) as any[]
    : db.query('SELECT * FROM users').all() as any[]

  const visibleUsers = users.filter((user: any) => !blockedIds.has(user.id))
  const ids = visibleUsers.map((u: any) => u.id)
  const activities = ids.length ? db.query(`SELECT * FROM activities WHERE user_id IN (${ids.join(', ')})`).all() as any[] : []
  const stats = ids.length ? db.query(`SELECT * FROM territory_stats WHERE user_id IN (${ids.join(', ')})`).all() as any[] : []
  const followers = ids.length ? db.query(`SELECT * FROM follows WHERE following_id IN (${ids.join(', ')})`).all() as any[] : []

  const activityCount = new Map<number, number>()
  for (const a of activities)
    activityCount.set(a.user_id, (activityCount.get(a.user_id) ?? 0) + 1)
  const followerCount = new Map<number, number>()
  for (const f of followers)
    followerCount.set(f.following_id, (followerCount.get(f.following_id) ?? 0) + 1)
  const statsByUser = new Map(stats.map((s: any) => [s.user_id, s]))

  const from = q.length < 2 ? ask.from : null
  const isNear = (u: any): boolean => from !== null && nearTown(u.location, from)

  const athletes = visibleUsers
    .map((u: any) => ({
      id: u.id,
      name: u.name,
      avatar: avatarOf(u),
      nearYou: isNear(u),
      activityCount: activityCount.get(u.id) ?? 0,
      followerCount: followerCount.get(u.id) ?? 0,
      territoriesOwned: statsByUser.get(u.id)?.total_territories_owned ?? 0,
      totalAreaOwned: statsByUser.get(u.id)?.total_area_owned ?? 0,
    }))
    .sort((a: any, b: any) => Number(b.nearYou) - Number(a.nearYou) || b.activityCount - a.activityCount || b.followerCount - a.followerCount || a.id - b.id)

  const paged = paginate(athletes, ask.page)
  return { athletes: paged.items, meta: paged.meta }
}

const FIRST_PAGE: PageParams = { offset: 0, limit: 20 }

describe('the athlete directory, by hand', () => {
  // Ana has three runs, Ben two, Cy one and three followers, Di none. Eve
  // blocked Ben. Cy and Di live near Denver, Ben in San Diego.
  const setup = () => {
    const db = open()
    insertUsers(db, [
      { id: 1, name: 'Ana Ridge', avatar: '/api/avatars/1/0f8fad5b-d9cb-469f-a165-70867728950e.jpg' },
      { id: 2, name: 'Ben Hollow', location: 'San Diego, CA', avatar: 'javascript:alert(1)' },
      { id: 3, name: 'Cy Anders', location: 'Boulder, CO' },
      { id: 4, name: 'Di Mesa', location: 'Denver, CO' },
      { id: 5, name: 'Eve North' },
    ])
    insertActivities(db, [
      ...[1, 1, 1, 2, 2, 3].map(user_id => ({ user_id, visibility: 'public' as const, distance: 1, completed_at: '2026-10-01T10:00:00.000Z' })),
      // Private runs count too: the count is of runs, not of what is shown.
      { user_id: 4, visibility: 'private', distance: 1, completed_at: null },
    ])
    insertFollows(db, [[1, 3], [2, 3], [4, 3], [3, 1]])
    insertBlocks(db, [[5, 2]])
    db.run(`INSERT INTO territory_stats (user_id, total_territories_owned, total_area_owned) VALUES (1, 4, 2.5), (3, NULL, NULL)`)
    return db
  }

  it('lists the most active first, with their numbers', async () => {
    const { athletes, meta } = await fromSql(setup(), { viewer: null, q: '', from: null, page: FIRST_PAGE })

    expect(athletes.map(a => a.id)).toEqual([1, 2, 3, 4, 5])
    expect(athletes[0]).toEqual({
      id: 1,
      name: 'Ana Ridge',
      avatar: '/api/avatars/1/0f8fad5b-d9cb-469f-a165-70867728950e.jpg',
      nearYou: false,
      activityCount: 3,
      followerCount: 1,
      territoriesOwned: 4,
      totalAreaOwned: 2.5,
    })
    expect(athletes[1]).toMatchObject({ avatar: null, activityCount: 2, followerCount: 0, territoriesOwned: 0, totalAreaOwned: 0 })
    expect(athletes[2]).toMatchObject({ activityCount: 1, followerCount: 3, territoriesOwned: 0, totalAreaOwned: 0 })
    expect(meta).toEqual({ offset: 0, limit: 20, total: 5, hasMore: false })
  })

  it('puts the athletes near the asker first', async () => {
    const { athletes } = await fromSql(setup(), { viewer: null, q: '', from: DENVER, page: FIRST_PAGE })

    expect(athletes.map(a => [a.id, a.nearYou])).toEqual([[3, true], [4, true], [1, false], [2, false], [5, false]])
  })

  it('hides both sides of a block', async () => {
    const db = setup()

    expect((await fromSql(db, { viewer: 5, q: '', from: null, page: FIRST_PAGE })).athletes.map(a => a.id)).toEqual([1, 3, 4, 5])
    expect((await fromSql(db, { viewer: 2, q: '', from: null, page: FIRST_PAGE })).meta.total).toBe(4)
  })

  it('searches names case-insensitively, and ignores where the asker is', async () => {
    const { athletes, meta } = await fromSql(setup(), { viewer: null, q: 'AN', from: DENVER, page: FIRST_PAGE })

    expect(athletes.map(a => a.id)).toEqual([1, 3])
    expect(athletes.every(a => !a.nearYou)).toBe(true)
    expect(meta).toEqual({ offset: 0, limit: 20, total: 2, hasMore: false })
  })

  it('counts every match in meta, whatever the page', async () => {
    const { athletes, meta } = await fromSql(setup(), { viewer: null, q: '', from: null, page: { offset: 1, limit: 2 } })

    expect(athletes.map(a => a.id)).toEqual([2, 3])
    expect(meta).toEqual({ offset: 1, limit: 2, total: 5, hasMore: true })
  })

  it('agrees with the old in-memory list', async () => {
    const db = setup()
    for (const viewer of [null, 1, 2, 5]) {
      for (const q of ['', 'a', 'an', 'NORTH', 'zz']) {
        for (const from of [null, DENVER, SAN_DIEGO])
          expect(await fromSql(db, { viewer, q, from, page: FIRST_PAGE })).toEqual(inMemory(db, { viewer, q, from, page: FIRST_PAGE }))
      }
    }
  })
})

describe('the SQL against the old list, on mixed data', () => {
  const names = ['Ana', 'ana', 'ANDREA', 'Ben', 'Benedikt', 'Cy', 'Dee', 'Émile', 'zoë', '100% Hills', 'snake_case', 'O\'Hara']
  const towns = [...Object.keys(TOWNS), 'Atlantis', '', null]
  const pages: PageParams[] = [{ offset: 0, limit: 20 }, { offset: 7, limit: 5 }, { offset: 30, limit: 50 }, { offset: 200, limit: 20 }]

  for (const seed of [1, 7, 42, 971]) {
    it(`matches for every viewer, query, place and page (seed ${seed})`, async () => {
      const next = seeded(seed)
      const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]
      const ids = Array.from({ length: 40 }, (_, i) => i + 1)

      const db = open()
      insertUsers(db, ids.map((id): UserFixture => ({
        id,
        name: next() < 0.05 ? null : `${pick(names)} ${pick(names)}`,
        avatar: next() < 0.3 ? `/api/avatars/${id}/0f8fad5b-d9cb-469f-a165-70867728950e.jpg` : null,
        location: pick(towns),
      })))
      // Few distinct counts, so the tie-breaks decide most of the order.
      const activities: ActivityRowFixture[] = []
      for (const id of ids) {
        for (let n = Math.floor(next() * 4); n > 0; n--)
          activities.push({ user_id: id, visibility: pick(['public', 'followers', 'private'] as const), distance: 1, completed_at: null })
      }
      activities.push({ user_id: null, visibility: 'public', distance: 1, completed_at: null })
      insertActivities(db, activities)
      const follows: Array<[number, number]> = []
      const blocks: Array<[number, number]> = []
      for (const follower of ids) {
        for (const following of ids) {
          if (follower !== following && next() < 0.06)
            follows.push([follower, following])
          if (follower !== following && next() < 0.01)
            blocks.push([follower, following])
        }
      }
      insertFollows(db, follows)
      insertBlocks(db, blocks)
      for (const id of ids) {
        if (next() < 0.4)
          db.run('INSERT INTO territory_stats (user_id, total_territories_owned, total_area_owned) VALUES (?, ?, ?)', [id, next() < 0.2 ? null : Math.floor(next() * 5), next() < 0.2 ? null : Math.floor(next() * 40) / 8])
      }

      const viewers = [null, ...blocks.slice(0, 4).flat(), 1, 99]
      for (const viewer of viewers) {
        for (const q of ['', 'a', 'an', 'BEN', 'é', '%', '_', '0%', 'o\'h', 'nobody']) {
          for (const from of [null, DENVER]) {
            for (const page of pages)
              expect(await fromSql(db, { viewer, q, from, page })).toEqual(inMemory(db, { viewer, q, from, page }))
          }
        }
      }
    })
  }
})

describe('the queries', () => {
  const discover = { text: '', blocked: [2, 3], near: [4, 5], page: FIRST_PAGE }

  it('count activities from the index alone, never reading a track', () => {
    const db = open()
    for (const search of [discover, { ...discover, text: 'ana' }]) {
      const { sql, params } = athletePageSql(search)
      const plan = planOf(db, sql, params)

      expect(plan).toContain('activities_user_completed_index (user_id=?)')
      expect(plan).toMatch(/USING COVERING INDEX activities_user_completed_index/)
      expect(plan).not.toMatch(/SCAN a\b/)
      expect(sql).not.toContain('gpx')
    }
  })

  it('look each athlete\'s territory up by its unique index', () => {
    const plan = planOf(open(), athletePageSql(discover).sql)

    expect(plan).toMatch(/territory_stats.*\(user_id=\?\)/)
  })

  it('bind the name and inline nothing a caller could carry', async () => {
    const db = open()
    insertUsers(db, [{ id: 1, name: 'Ana' }])
    const hostile = ['1) OR (1=1', 1.5, -3, 0] as unknown as number[]
    const search = { text: '\'; DROP TABLE users; --', blocked: hostile, near: hostile, page: FIRST_PAGE }

    for (const { sql } of [athletePageSql(search), athleteCountSql(search)]) {
      expect(sql).not.toContain('DROP')
      expect(sql).not.toContain('1=1')
      expect(sql).not.toContain('1.5')
    }
    expect((await searchAthletes(runner(db), search)).meta.total).toBe(0)
    expect((await searchAthletes(runner(db), { ...search, text: '' })).meta.total).toBe(1)
  })
})

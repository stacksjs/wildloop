import type { Database } from 'bun:sqlite'
import type { FeedRow, RunSql } from '../../app/Support/clubRecentFeed'
import { afterEach, describe, expect, it } from 'bun:test'
import { FEED_SIZE, feedPageSql, feedRowsSql, feedStragglersSql, newestFirst, recentClubFeed } from '../../app/Support/clubRecentFeed'
import { canViewActivity } from '../../resources/functions/visibility'
import { type ActivityFixture, clubDatabase as openClubDatabase, DAY, READABLE_STAMPS, seeded } from '../fixtures/clubDatabase'

/**
 * The club page's recent feed (`GET /api/clubs/{id}`) is read from the
 * (user_id, completed_at) index a page at a time now, instead of loading every
 * activity the members ever recorded and sorting them in memory. The old
 * in-memory version is kept below as the reference, and both get the same
 * tables for every viewer.
 *
 * The old sort was stable over whatever order SQLite returned rows in; the
 * reference reads them in id order, which is the order the new feed gives
 * activities stamped at the same instant.
 */

const NOW = Date.parse('2026-10-03T15:30:12.345Z')
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString()

let database: Database | null = null

afterEach(() => {
  database?.close()
  database = null
})

function clubDatabase(...args: Parameters<typeof openClubDatabase>): Database {
  database = openClubDatabase(...args)
  return database
}

/** `db.sql` in the action; here the same SQL against SQLite, with a tally. */
function runner(db: Database): RunSql & { calls: string[] } {
  const calls: string[] = []
  const run = async (sql: string) => {
    calls.push(sql)
    return db.query(sql).all() as any[]
  }
  return Object.assign(run, { calls })
}

async function feedIds(db: Database, clubId: number, viewer: number | null): Promise<number[]> {
  return (await recentClubFeed(runner(db), clubId, viewer)).map(row => Number(row.id))
}

/** The feed as `ClubShowAction` worked it out before. */
function inMemoryIds(db: Database, clubId: number, sessionUser: number | null): number[] {
  const memberIds = (db.query('SELECT user_id FROM club_members WHERE club_id = ?').all(clubId) as any[]).map((m: any) => m.user_id)
  const allActivities = memberIds.length
    ? db.query(`SELECT * FROM activities WHERE user_id IN (${memberIds.join(', ')}) ORDER BY id`).all() as any[]
    : []
  const viewerFollowing = sessionUser !== null
    ? new Set((db.query('SELECT * FROM follows WHERE follower_id = ?').all(sessionUser) as any[]).map((f: any) => f.following_id))
    : new Set<number>()
  const activities = allActivities.filter((a: any) => canViewActivity(a, sessionUser, viewerFollowing))
  const sortedActivities = [...activities]
    .sort((a: any, b: any) =>
      Date.parse(b.completed_at ?? b.created_at ?? '') - Date.parse(a.completed_at ?? a.created_at ?? ''))
  return sortedActivities.slice(0, 10).map((a: any) => Number(a.id))
}

describe('the club feed, by viewer', () => {
  // Club 1 is owner (1) and runner (2); fan (3) follows runner. Ids follow
  // the order below, starting at 1.
  const activities: ActivityFixture[] = [
    { user_id: 2, visibility: 'public', distance: 1, completed_at: iso(1) },
    { user_id: 2, visibility: 'followers', distance: 2, completed_at: iso(2) },
    { user_id: 2, visibility: 'private', distance: 4, completed_at: iso(0.5) },
    { user_id: 1, visibility: 'private', distance: 8, completed_at: iso(0.25) },
    { user_id: 1, visibility: null, distance: 16, completed_at: iso(30) },
    { user_id: 3, visibility: 'public', distance: 32, completed_at: iso(0.1) },
  ]
  const setup = () => clubDatabase([[1, 1], [1, 2]], [[3, 2]], activities)

  it('shows someone signed out only public runs, newest first', async () => {
    expect(await feedIds(setup(), 1, null)).toEqual([1, 5])
  })

  it('adds followers-only runs for a follower, and never a private one', async () => {
    expect(await feedIds(setup(), 1, 3)).toEqual([1, 2, 5])
  })

  it('shows members their own private runs and nobody else\'s (#957)', async () => {
    expect(await feedIds(setup(), 1, 1)).toEqual([4, 1, 5])
    expect(await feedIds(setup(), 1, 2)).toEqual([3, 1, 2, 5])
  })

  it('leaves out people who are not members', async () => {
    expect(await feedIds(setup(), 1, 3)).not.toContain(6)
    expect(await feedIds(setup(), 9, null)).toEqual([])
  })

  it('agrees with the old in-memory feed for every viewer', async () => {
    const db = setup()
    for (const viewer of [null, 1, 2, 3, 99])
      expect(await feedIds(db, 1, viewer)).toEqual(inMemoryIds(db, 1, viewer))
  })
})

describe('reading the feed a page at a time', () => {
  it('pages past runs the viewer may not see', async () => {
    // A hundred newer private runs ahead of five public ones.
    const db = clubDatabase([[1, 1]], [], [
      ...Array.from({ length: 5 }, (_, i): ActivityFixture => ({ user_id: 1, visibility: 'public', distance: 1, completed_at: iso(10 + i) })),
      ...Array.from({ length: 100 }, (_, i): ActivityFixture => ({ user_id: 1, visibility: 'private', distance: 1, completed_at: iso(i / 24) })),
    ])
    const run = runner(db)

    expect((await recentClubFeed(run, 1, null)).map(row => Number(row.id))).toEqual([1, 2, 3, 4, 5])
    expect(run.calls.filter(sql => sql.includes('ORDER BY a.completed_at DESC')).length).toBe(3)
    // The owner sees the hundred, and one page of index entries is enough.
    const own = runner(db)
    expect(await recentClubFeed(own, 1, 1)).toHaveLength(FEED_SIZE)
    expect(own.calls.filter(sql => sql.includes('ORDER BY a.completed_at DESC')).length).toBe(1)
  })

  it('carries on across a page boundary inside one instant', async () => {
    const same = iso(1)
    const db = clubDatabase([[1, 1], [1, 2]], [], Array.from({ length: 130 }, (_, i): ActivityFixture => ({
      user_id: 1 + (i % 2),
      visibility: i % 7 === 0 ? 'public' : 'private',
      distance: 1,
      completed_at: same,
    })))

    for (const viewer of [null, 1, 2])
      expect(await feedIds(db, 1, viewer)).toEqual(inMemoryIds(db, 1, viewer))
  })

  it('reads the page from the index alone, without activity rows', () => {
    const db = clubDatabase([], [], [])
    const plan = (db.query(`EXPLAIN QUERY PLAN ${feedPageSql(1, { completedAt: iso(1), id: 5 })}`).all() as Array<{ detail: string }>)
      .map(row => row.detail)
      .join('\n')

    expect(plan).toContain('USING COVERING INDEX activities_user_completed_index')
  })

  it('finds the odd stamps through the index that holds only them', () => {
    const db = clubDatabase([], [], [])
    const plan = (db.query(`EXPLAIN QUERY PLAN ${feedStragglersSql(1, 3)}`).all() as Array<{ detail: string }>)
      .map(row => row.detail)
      .join('\n')

    expect(plan).toContain('activities_odd_completed_index (user_id=?)')
  })

  it('leaves nothing in the SQL that an id or cursor could carry', () => {
    const hostile = '1) OR (1=1' as unknown as number
    expect(feedRowsSql([hostile, 4], null)).not.toContain('1=1')
    expect(feedPageSql(hostile, { completedAt: '\' OR \'1\'=\'1', id: hostile })).not.toContain('\'1\'=\'1\'')
  })
})

describe('ordering', () => {
  const row = (id: number, completed_at: string | null, created_at: string | null = null): FeedRow =>
    ({ id, user_id: 1, trail_id: null, activity_type: 'Trail Run', distance: 1, duration: '30:00', completed_at, created_at })

  it('falls back to created_at only when completed_at is missing', () => {
    expect(newestFirst([row(1, iso(3)), row(2, null, iso(1)), row(3, iso(2))]).map(r => r.id)).toEqual([2, 3, 1])
  })

  it('keeps id order inside one instant, and puts unreadable times last', () => {
    expect(newestFirst([row(4, 'last tuesday'), row(3, iso(1)), row(1, iso(1)), row(2, ''), row(5, iso(2))]).map(r => r.id))
      .toEqual([1, 3, 5, 2, 4])
  })
})

describe('the feed against the old one, on mixed data', () => {
  const visibilities = ['public', 'followers', 'private', null] as const

  for (const seed of [3, 11, 64, 957]) {
    it(`matches for every viewer (seed ${seed})`, async () => {
      const next = seeded(seed)
      const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]
      const users = [1, 2, 3, 4, 5]

      const memberships: Array<[number, number]> = []
      for (const club of [1, 2]) {
        for (const user of users) {
          if (next() < 0.6)
            memberships.push([club, user])
        }
      }
      const follows: Array<[number, number]> = []
      for (const follower of users) {
        for (const following of users) {
          if (follower !== following && next() < 0.3)
            follows.push([follower, following])
        }
      }
      const activities: ActivityFixture[] = Array.from({ length: 250 }, () => {
        // Whole minutes, so some land on the same instant.
        const ms = NOW - Math.floor(next() * 20 * 24 * 60) * 60_000
        const missing = next() < 0.05
        return {
          user_id: pick(users),
          visibility: pick(visibilities),
          distance: 1,
          completed_at: missing ? null : pick(READABLE_STAMPS)(ms),
          created_at: missing ? new Date(ms).toISOString() : undefined,
        }
      })

      const db = clubDatabase(memberships, follows, activities)
      for (const viewer of [null, ...users, 99]) {
        for (const club of [1, 2])
          expect(await feedIds(db, club, viewer)).toEqual(inMemoryIds(db, club, viewer))
      }
    })
  }
})

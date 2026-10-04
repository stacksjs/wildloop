import type { Database } from 'bun:sqlite'
import type { BoardMetric, BoardQuery, BoardScope } from '../../app/Support/activityLeaderboard'
import { afterEach, describe, expect, it } from 'bun:test'
import { activityLeaderboard, boardStragglersSql, boardTotalsSql } from '../../app/Support/activityLeaderboard'
import { avatarOf } from '../../app/Support/avatars'
import { DAY, READABLE_STAMPS, seeded, UNREADABLE_STAMPS, withOffset } from '../fixtures/clubDatabase'
import {
  type ActivityRowFixture,
  blockedFor,
  directoryDatabase,
  insertActivities,
  insertBlocks,
  insertFollows,
  insertUsers,
  planOf,
} from '../fixtures/directoryDatabase'

/**
 * `GET /api/activities/leaderboard` sums per athlete in SQL now. It used to
 * load every activity in the period, tracks and all, and sum in memory. That
 * version is kept below as the reference: the same tables go to both, and
 * every board has to come out the same for every viewer, scope, period and
 * metric.
 */

const NOW = Date.parse('2026-10-03T15:30:12.345Z')

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
  scope: BoardScope
  viewer: number | null
  locals: number[]
  days: number | null
  metric: BoardMetric
}

/** What the action does now, minus the HTTP. */
async function fromSql(db: Database, ask: Ask) {
  const run = async (sql: string) => db.query(sql).all() as any[]
  return await activityLeaderboard(run, {
    scope: ask.scope,
    viewer: ask.viewer,
    locals: ask.scope === 'local' ? ask.locals : undefined,
    blocked: blockedFor(db, ask.viewer),
    since: ask.days ? NOW - ask.days * 86400000 : null,
  }, ask.metric)
}

/** The action as it was, reading every activity in the period. */
function inMemory(db: Database, ask: Ask) {
  const { scope, viewer: viewerId, metric, days } = ask
  const blockedIds = blockedFor(db, viewerId)
  const following = viewerId
    ? new Set((db.query('SELECT * FROM follows WHERE follower_id = ?').all(viewerId) as any[]).map(row => row.following_id))
    : new Set<number>()
  if (viewerId)
    following.add(viewerId)

  const cutoff = days ? NOW - days * 86400000 : 0
  const where: string[] = []
  const params: any[] = []
  if (scope === 'local') {
    if (ask.locals.length === 0)
      return []
    where.push(`visibility = 'public'`, `user_id IN (${ask.locals.join(', ')})`)
  }
  else if (scope === 'global') {
    where.push(`visibility = 'public'`)
  }
  else if (following.size) {
    where.push(`user_id IN (${[...following].join(', ')})`)
  }
  else {
    return []
  }
  if (days) {
    where.push('completed_at >= ?')
    params.push(new Date(cutoff).toISOString())
  }
  let activities = db.query(`SELECT * FROM activities WHERE ${where.join(' AND ')}`).all(...params) as any[]
  activities = activities.filter((activity: any) => {
    if (blockedIds.has(activity.user_id))
      return false
    if (scope === 'following' && !following.has(activity.user_id))
      return false
    const visible = activity.visibility === 'public'
      || (scope === 'following' && activity.visibility === 'followers' && following.has(activity.user_id))
      || (scope === 'following' && activity.visibility === 'private' && activity.user_id === viewerId)
    if (!visible)
      return false
    return new Date(activity.completed_at ?? activity.created_at).getTime() >= cutoff
  })

  const totals = new Map<number, { totalDistance: number, totalElevation: number, activities: number }>()
  for (const activity of activities) {
    const current = totals.get(activity.user_id) ?? { totalDistance: 0, totalElevation: 0, activities: 0 }
    current.totalDistance += activity.distance || 0
    current.totalElevation += activity.elevation || 0
    current.activities++
    totals.set(activity.user_id, current)
  }
  const users = totals.size ? db.query(`SELECT * FROM users WHERE id IN (${[...totals.keys()].filter(id => id !== null).join(', ') || 'NULL'})`).all() as any[] : []
  const names = new Map(users.map((user: any) => [user.id, user.name]))
  const avatars = new Map(users.map((user: any) => [user.id, avatarOf(user)]))
  const sortValue = (entry: any) => metric === 'elevation'
    ? entry.totalElevation
    : metric === 'activities' ? entry.trailsCompleted : entry.totalDistance
  return [...totals.entries()]
    .map(([userId, total]) => ({
      userId,
      userName: names.get(userId) ?? 'Athlete',
      userAvatar: avatars.get(userId) ?? null,
      totalDistance: Number(total.totalDistance.toFixed(2)),
      totalElevation: Math.round(total.totalElevation),
      trailsCompleted: total.activities,
    }))
    .sort((a, b) => sortValue(b) - sortValue(a) || a.userId - b.userId)
    .slice(0, 100)
    .map((entry, index) => ({ rank: index + 1, ...entry }))
}

const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString()
const ask = (overrides: Partial<Ask>): Ask => ({ scope: 'global', viewer: null, locals: [], days: 7, metric: 'distance', ...overrides })

describe('the board, by hand', () => {
  // Runner (2) and climber (3) post; fan (1) follows runner; 4 follows nobody.
  // Distances are powers of two, so each total names the runs in it.
  const setup = () => {
    const db = open()
    insertUsers(db, [
      { id: 1, name: 'Fan' },
      { id: 2, name: 'Runner', avatar: '/api/avatars/2/0f8fad5b-d9cb-469f-a165-70867728950e.jpg' },
      { id: 3, name: 'Climber' },
      { id: 4, name: 'Stranger' },
    ])
    insertActivities(db, [
      { user_id: 2, visibility: 'public', distance: 1, elevation: 100, completed_at: iso(1) },
      { user_id: 2, visibility: 'followers', distance: 2, elevation: 0, completed_at: iso(2) },
      { user_id: 2, visibility: 'private', distance: 4, elevation: 0, completed_at: iso(3) },
      { user_id: 2, visibility: 'public', distance: 8, elevation: 0, completed_at: iso(20) },
      { user_id: 2, visibility: 'public', distance: 16, elevation: 0, completed_at: withOffset(NOW - 2 * DAY, 120) },
      { user_id: 3, visibility: 'public', distance: 3, elevation: 900, completed_at: iso(1) },
      { user_id: 3, visibility: 'public', distance: 0.25, elevation: 0, completed_at: null, created_at: '2026-10-02 09:00:00' },
      { user_id: 1, visibility: 'private', distance: 64, elevation: 0, completed_at: iso(1) },
    ])
    insertFollows(db, [[1, 2]])
    return db
  }

  it('ranks the public week by distance', async () => {
    expect(await fromSql(setup(), ask({}))).toEqual([
      { rank: 1, userId: 2, userName: 'Runner', userAvatar: '/api/avatars/2/0f8fad5b-d9cb-469f-a165-70867728950e.jpg', totalDistance: 17, totalElevation: 100, trailsCompleted: 2 },
      { rank: 2, userId: 3, userName: 'Climber', userAvatar: null, totalDistance: 3, totalElevation: 900, trailsCompleted: 1 },
    ])
  })

  it('ranks by the metric asked for', async () => {
    expect((await fromSql(setup(), ask({ metric: 'elevation' }))).map(e => e.userId)).toEqual([3, 2])
  })

  it('counts an activity with no completed_at by when it was saved, for all time only', async () => {
    const board = await fromSql(setup(), ask({ days: null }))

    expect(board.find(e => e.userId === 3)).toMatchObject({ totalDistance: 3.25, trailsCompleted: 2 })
    expect(board.find(e => e.userId === 2)).toMatchObject({ totalDistance: 1 + 8 + 16, trailsCompleted: 3 })
  })

  it('shows a follower the followers-only runs, and the viewer their own private ones', async () => {
    expect(await fromSql(setup(), ask({ scope: 'following', viewer: 1 }))).toMatchObject([
      { rank: 1, userId: 1, totalDistance: 64 },
      { rank: 2, userId: 2, totalDistance: 1 + 2 + 16, trailsCompleted: 3 },
    ])
    expect((await fromSql(setup(), ask({ scope: 'following', viewer: 2 })))[0]).toMatchObject({ userId: 2, totalDistance: 1 + 2 + 4 + 16, trailsCompleted: 4 })
  })

  it('has no following board for someone signed out, and no local board for nobody local', async () => {
    expect(await fromSql(setup(), ask({ scope: 'following' }))).toEqual([])
    expect(await fromSql(setup(), ask({ scope: 'local', locals: [] }))).toEqual([])
    expect((await fromSql(setup(), ask({ scope: 'local', locals: [3] }))).map(e => e.userId)).toEqual([3])
  })

  it('hides both sides of a block', async () => {
    const db = setup()
    insertBlocks(db, [[2, 4]])

    expect((await fromSql(db, ask({ viewer: 4 }))).map(e => e.userId)).toEqual([3])
    expect((await fromSql(db, ask({ viewer: 2 }))).map(e => e.userId)).toEqual([2, 3])
  })

  it('agrees with the old in-memory board', async () => {
    const db = setup()
    insertBlocks(db, [[3, 4]])
    for (const viewer of [null, 1, 2, 3, 4, 99]) {
      for (const scope of ['global', 'following', 'local'] as const) {
        for (const days of [7, 30, null]) {
          for (const metric of ['distance', 'elevation', 'activities'] as const) {
            const asked = ask({ scope, viewer, days, metric, locals: [2, 4] })
            expect(await fromSql(db, asked)).toEqual(inMemory(db, asked))
          }
        }
      }
    }
  })
})

describe('the SQL against the old board, on mixed data', () => {
  const stamps = [...READABLE_STAMPS, ...UNREADABLE_STAMPS]
  const visibilities = ['public', 'public', 'followers', 'private', null] as const
  // Both shapes `created_at` comes in: the column default, and toISOString().
  const created = [
    (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' '),
    (ms: number) => new Date(ms).toISOString(),
  ]

  for (const seed of [1, 7, 42, 2026]) {
    it(`matches for every viewer, scope, period and metric (seed ${seed})`, async () => {
      const next = seeded(seed)
      const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]
      const users = [1, 2, 3, 4, 5, 6, 7, 8]

      const db = open()
      insertUsers(db, users.map(id => ({ id, name: next() < 0.1 ? null : `Athlete ${id}` })))
      const follows: Array<[number, number]> = []
      const blocks: Array<[number, number]> = []
      for (const follower of users) {
        for (const following of users) {
          if (follower !== following && next() < 0.3)
            follows.push([follower, following])
          if (follower !== following && next() < 0.04)
            blocks.push([follower, following])
        }
      }
      insertFollows(db, follows)
      insertBlocks(db, blocks)
      const activities: ActivityRowFixture[] = Array.from({ length: 400 }, () => {
        // Clustered around both cutoffs, with a few from before 1970.
        const at = next() < 0.03 ? Date.parse('1969-12-25T00:00:00Z') : NOW - pick([7, 30, 90]) * DAY + (next() - 0.5) * 6 * DAY
        return {
          user_id: next() < 0.02 ? null : pick(users),
          visibility: pick(visibilities),
          // Quarter miles and whole feet add up exactly in any order.
          distance: next() < 0.05 ? null : Math.floor(next() * 80) / 4,
          elevation: next() < 0.1 ? null : Math.floor(next() * 500),
          completed_at: pick(stamps)(at),
          created_at: next() < 0.5 ? undefined : pick(created)(at - next() * DAY),
        }
      })
      insertActivities(db, activities)

      for (const viewer of [null, ...users, 99]) {
        for (const scope of ['global', 'following', 'local'] as const) {
          for (const days of [7, 30, null]) {
            for (const metric of ['distance', 'elevation', 'activities'] as const) {
              const asked = ask({ scope, viewer, days, metric, locals: [1, 3, 4, 8] })
              expect(await fromSql(db, asked)).toEqual(inMemory(db, asked))
            }
          }
        }
      }
    })
  }

  it('keeps the top hundred, ties to the lower id', async () => {
    const db = open()
    const ids = Array.from({ length: 130 }, (_, i) => i + 1)
    insertUsers(db, ids.map(id => ({ id, name: `Athlete ${id}` })))
    insertActivities(db, ids.map(id => ({ user_id: id, visibility: 'public', distance: id % 7, elevation: id % 3, completed_at: iso(1) })))

    for (const metric of ['distance', 'elevation', 'activities'] as const) {
      const board = await fromSql(db, ask({ metric }))
      expect(board).toHaveLength(100)
      expect(board).toEqual(inMemory(db, ask({ metric })))
    }
  })
})

describe('the queries', () => {
  const query = (scope: BoardScope, since: number | null): BoardQuery => ({ scope, viewer: 3, locals: [1, 2], blocked: [5], since })

  it('sum every board from the board index, never an activity row', () => {
    const db = open()
    for (const scope of ['global', 'local', 'following'] as const) {
      for (const since of [NOW - 7 * DAY, null]) {
        const plan = planOf(db, boardTotalsSql(query(scope, since)) as string)

        expect(plan).toContain('SEARCH a USING COVERING INDEX activities_board_index (visibility=?')
        expect(plan).not.toContain('MULTI-INDEX OR')
      }
    }
  })

  it('read a public period as a range of the index', () => {
    const db = open()
    for (const scope of ['global', 'local'] as const) {
      const plan = planOf(db, boardTotalsSql(query(scope, NOW - 7 * DAY)) as string)

      expect(plan).toContain('activities_board_index (visibility=? AND completed_at>?)')
    }
  })

  // The odd stamps are tested from the index before any row is read: a row
  // is fetched only for an activity the query returns. Two index reads merged
  // by rowid (MULTI-INDEX OR) would fetch every row first, tracks and all.
  it('find the odd stamps in an index holding completed_at, one index per query', () => {
    const db = open()
    for (const scope of ['global', 'local', 'following'] as const) {
      for (const since of [NOW - 7 * DAY, null]) {
        const plan = planOf(db, boardStragglersSql(query(scope, since)) as string)

        expect(plan).toMatch(/SEARCH a USING INDEX (activities_board_index|activities_odd_completed_index|activities_user_completed_index)/)
        expect(plan).not.toContain('MULTI-INDEX OR')
        expect(plan).not.toMatch(/SCAN a\b/)
      }
    }
  })

  it('leave nothing in the SQL that an id could carry', () => {
    const hostile = '1 OR 1=1' as unknown as number
    const sql = [
      boardTotalsSql({ scope: 'following', viewer: hostile, blocked: [hostile], since: null }),
      boardTotalsSql({ scope: 'local', viewer: null, locals: [hostile, 2], blocked: [1.5], since: null }),
      boardStragglersSql({ scope: 'global', viewer: null, blocked: [hostile], since: NOW }),
    ].join('\n')

    expect(sql).not.toContain('1=1')
    expect(sql).not.toContain('1.5')
  })
})

import type { Database } from 'bun:sqlite'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  clubMembershipSql,
  clubWeekStragglersSql,
  clubWeekTotalsSql,
  memberWeekStragglersSql,
  memberWeekTotalsSql,
  type MembershipRow,
  tallyWeeks,
  WEEK_MS,
  type WeekActivityRow,
  weekCutoff,
  type WeekTotalRow,
} from '../../app/Support/clubWeeklyStats'
import { canViewActivity } from '../../resources/functions/visibility'
import { type ActivityFixture, clubDatabase as openClubDatabase, DAY, READABLE_STAMPS, seeded, UNREADABLE_STAMPS, withOffset } from '../fixtures/clubDatabase'

/**
 * `GET /api/clubs` and the leaderboard on `GET /api/clubs/{id}` count this
 * week's mileage in SQL now. They used to load every activity and work it
 * out in memory, and those in-memory versions are kept below, verbatim, as
 * the reference: the same tables go to both, and every club and member has
 * to come out the same for every viewer. The schema is the app's own
 * migrations (see tests/fixtures/clubDatabase).
 */

const NOW = Date.parse('2026-10-03T15:30:12.345Z')

interface ClubWeekRow {
  memberCount: number
  isMember: boolean
  weeklyDistance: number
  activitiesThisWeek: number
}

let database: Database | null = null

afterEach(() => {
  database?.close()
  database = null
})

function clubDatabase(...args: Parameters<typeof openClubDatabase>): Database {
  database = openClubDatabase(...args)
  return database
}

/** What the action now does, minus the HTTP. */
function fromSql(db: Database, viewer: number | null, now: number): Map<number, ClubWeekRow> {
  const since = weekCutoff(now)
  const memberships = db.query(clubMembershipSql(viewer)).all() as MembershipRow[]
  const totals = db.query(clubWeekTotalsSql(viewer, since)).all() as WeekTotalRow[]
  const stragglers = db.query(clubWeekStragglersSql(viewer)).all() as WeekActivityRow[]
  const weeks = tallyWeeks(totals, stragglers, since)

  const clubs = new Map<number, ClubWeekRow>()
  for (const m of memberships) {
    const week = weeks.get(Number(m.club_id))
    clubs.set(Number(m.club_id), {
      memberCount: Number(m.members) || 0,
      isMember: !!m.is_member,
      weeklyDistance: Math.round(week?.distance ?? 0),
      activitiesThisWeek: week?.activities ?? 0,
    })
  }
  return clubs
}

/** The action as it was before, reading the whole tables. */
function inMemory(db: Database, sessionUser: number | null, now: number): Map<number, ClubWeekRow> {
  const memberships = db.query('SELECT * FROM club_members').all() as any[]
  const viewerFollowing = sessionUser !== null
    ? new Set((db.query('SELECT * FROM follows WHERE follower_id = ?').all(sessionUser) as any[]).map((f: any) => f.following_id))
    : new Set<number>()
  const activities = (db.query('SELECT * FROM activities').all() as any[]).filter((a: any) => canViewActivity(a, sessionUser, viewerFollowing))

  const membersByClub = new Map<number, number[]>()
  for (const m of memberships) {
    const list = membersByClub.get(m.club_id) ?? []
    list.push(m.user_id)
    membersByClub.set(m.club_id, list)
  }

  const weekAgoMs = now - 7 * 86400000
  const userWeekly = new Map<number, { dist: number, count: number }>()
  for (const a of activities) {
    const when = a.completed_at ? Date.parse(a.completed_at) : Number.NaN
    if (!Number.isFinite(when) || when < weekAgoMs)
      continue
    const w = userWeekly.get(a.user_id) ?? { dist: 0, count: 0 }
    w.dist += a.distance ?? 0
    w.count += 1
    userWeekly.set(a.user_id, w)
  }

  const clubs = new Map<number, ClubWeekRow>()
  for (const [clubId, members] of membersByClub) {
    let dist = 0
    let count = 0
    for (const uid of members) {
      const w = userWeekly.get(uid)
      if (w) {
        dist += w.dist
        count += w.count
      }
    }
    clubs.set(clubId, {
      memberCount: members.length,
      isMember: sessionUser !== null && members.includes(sessionUser),
      weeklyDistance: Math.round(dist),
      activitiesThisWeek: count,
    })
  }
  return clubs
}

interface MemberWeekRow {
  weeklyDistance: number
  weeklyActivities: number
}

/** One club's leaderboard weeks, as `ClubShowAction` now reads them. */
function membersFromSql(db: Database, clubId: number, viewer: number | null, now: number): Map<number, MemberWeekRow> {
  const since = weekCutoff(now)
  const totals = db.query(memberWeekTotalsSql(clubId, viewer, since)).all() as WeekTotalRow[]
  const stragglers = db.query(memberWeekStragglersSql(clubId, viewer)).all() as WeekActivityRow[]
  return new Map([...tallyWeeks(totals, stragglers, since)].map(([userId, week]) => [userId, {
    weeklyDistance: Math.round(week.distance * 10) / 10,
    weeklyActivities: week.activities,
  }]))
}

/** The same, as `ClubShowAction` worked it out before. */
function membersInMemory(db: Database, clubId: number, sessionUser: number | null, now: number): Map<number, MemberWeekRow> {
  const memberIds = (db.query('SELECT user_id FROM club_members WHERE club_id = ?').all(clubId) as any[]).map((m: any) => m.user_id)
  const allActivities = memberIds.length
    ? db.query(`SELECT * FROM activities WHERE user_id IN (${memberIds.join(', ')})`).all() as any[]
    : []
  const viewerFollowing = sessionUser !== null
    ? new Set((db.query('SELECT * FROM follows WHERE follower_id = ?').all(sessionUser) as any[]).map((f: any) => f.following_id))
    : new Set<number>()
  const activities = allActivities.filter((a: any) => canViewActivity(a, sessionUser, viewerFollowing))

  const weekAgoMs = now - 7 * 86400000
  const weeklyByUser = new Map<number, { dist: number, count: number }>()
  for (const a of activities) {
    const when = a.completed_at ? Date.parse(a.completed_at) : Number.NaN
    if (!Number.isFinite(when) || when < weekAgoMs)
      continue
    const w = weeklyByUser.get(a.user_id) ?? { dist: 0, count: 0 }
    w.dist += a.distance ?? 0
    w.count += 1
    weeklyByUser.set(a.user_id, w)
  }
  return new Map([...weeklyByUser].map(([userId, w]) => [userId, {
    weeklyDistance: Math.round(w.dist * 10) / 10,
    weeklyActivities: w.count,
  }]))
}

const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString()

describe('a club\'s week, by viewer', () => {
  // Club 1 is runner (2) and owner (1); club 2 is runner alone. Fan (3)
  // follows runner; stranger (4) follows nobody. Distances are powers of two,
  // so each total names exactly the activities that went into it.
  const activities: ActivityFixture[] = [
    { user_id: 2, visibility: 'public', distance: 1, completed_at: iso(1) },
    { user_id: 2, visibility: 'followers', distance: 2, completed_at: iso(2) },
    { user_id: 2, visibility: 'private', distance: 4, completed_at: iso(3) },
    { user_id: 2, visibility: 'public', distance: 8, completed_at: iso(9) },
    { user_id: 2, visibility: null, distance: 16, completed_at: withOffset(NOW - 2 * DAY, 120) },
    { user_id: 2, visibility: 'followers', distance: 32, completed_at: new Date(NOW - 4 * DAY).toUTCString() },
    { user_id: 1, visibility: 'private', distance: 64, completed_at: iso(1) },
  ]
  const setup = () => clubDatabase([[1, 1], [1, 2], [2, 2]], [[3, 2]], activities)

  it('counts only public mileage for someone signed out', () => {
    const clubs = fromSql(setup(), null, NOW)

    expect(clubs.get(1)).toEqual({ memberCount: 2, isMember: false, weeklyDistance: 1 + 16, activitiesThisWeek: 2 })
    expect(clubs.get(2)).toEqual({ memberCount: 1, isMember: false, weeklyDistance: 1 + 16, activitiesThisWeek: 2 })
  })

  it('counts the same for a signed-in stranger', () => {
    expect(fromSql(setup(), 4, NOW).get(1)).toEqual({ memberCount: 2, isMember: false, weeklyDistance: 17, activitiesThisWeek: 2 })
  })

  it('adds followers-only runs for someone who follows the athlete', () => {
    expect(fromSql(setup(), 3, NOW).get(1)).toEqual({ memberCount: 2, isMember: false, weeklyDistance: 1 + 2 + 16 + 32, activitiesThisWeek: 4 })
  })

  it('never lets one member\'s private run reach another member\'s view (#957)', () => {
    // Owner sees their own private 64 and the runner's public mileage, but
    // not the runner's followers-only or private runs.
    expect(fromSql(setup(), 1, NOW).get(1)).toEqual({ memberCount: 2, isMember: true, weeklyDistance: 64 + 1 + 16, activitiesThisWeek: 3 })
    // The runner sees everything of their own, and nothing private of the owner's.
    expect(fromSql(setup(), 2, NOW).get(1)).toEqual({ memberCount: 2, isMember: true, weeklyDistance: 1 + 2 + 4 + 16 + 32, activitiesThisWeek: 5 })
    expect(fromSql(setup(), 2, NOW).get(2)).toEqual({ memberCount: 1, isMember: true, weeklyDistance: 55, activitiesThisWeek: 5 })
  })

  it('agrees with the old in-memory count for every viewer', () => {
    const db = setup()
    for (const viewer of [null, 1, 2, 3, 4, 99])
      expect(fromSql(db, viewer, NOW)).toEqual(inMemory(db, viewer, NOW))
  })

  it('gives each member their own week on the leaderboard, by the same rule', () => {
    const db = setup()

    expect(membersFromSql(db, 1, null, NOW)).toEqual(new Map([[2, { weeklyDistance: 17, weeklyActivities: 2 }]]))
    expect(membersFromSql(db, 1, 3, NOW)).toEqual(new Map([[2, { weeklyDistance: 51, weeklyActivities: 4 }]]))
    expect(membersFromSql(db, 1, 1, NOW)).toEqual(new Map([
      [1, { weeklyDistance: 64, weeklyActivities: 1 }],
      [2, { weeklyDistance: 17, weeklyActivities: 2 }],
    ]))
    // Club 2 is the runner alone: the owner's runs are not its business.
    expect(membersFromSql(db, 2, 1, NOW)).toEqual(new Map([[2, { weeklyDistance: 17, weeklyActivities: 2 }]]))
    for (const viewer of [null, 1, 2, 3, 4, 99]) {
      for (const club of [1, 2, 3])
        expect(membersFromSql(db, club, viewer, NOW)).toEqual(membersInMemory(db, club, viewer, NOW))
    }
  })

  it('takes the week from the cutoff to the millisecond', () => {
    const cutoff = NOW - WEEK_MS
    const db = clubDatabase([[1, 1]], [], [
      { user_id: 1, visibility: 'public', distance: 1, completed_at: new Date(cutoff).toISOString() },
      { user_id: 1, visibility: 'public', distance: 2, completed_at: new Date(cutoff - 1).toISOString() },
      { user_id: 1, visibility: 'public', distance: 4, completed_at: withOffset(cutoff, -300) },
      { user_id: 1, visibility: 'public', distance: 8, completed_at: withOffset(cutoff - 1000, 300) },
    ])

    expect(fromSql(db, null, NOW).get(1)).toMatchObject({ weeklyDistance: 1 + 4, activitiesThisWeek: 2 })
  })
})

describe('the SQL against the old count, on mixed data', () => {
  const stamps = [...READABLE_STAMPS, ...UNREADABLE_STAMPS]
  const visibilities = ['public', 'followers', 'private', null] as const

  for (const seed of [1, 7, 42, 957]) {
    it(`matches for every club, member and viewer (seed ${seed})`, () => {
      const next = seeded(seed)
      const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]
      const users = [1, 2, 3, 4, 5, 6]

      const memberships: Array<[number, number]> = []
      for (const club of [1, 2, 3, 4]) {
        for (const user of users) {
          if (next() < 0.5)
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
      const activities: ActivityFixture[] = Array.from({ length: 300 }, () => ({
        user_id: pick(users),
        visibility: pick(visibilities),
        // Quarter miles add up exactly in any order, so rounding can't differ.
        distance: next() < 0.05 ? null : Math.floor(next() * 80) / 4,
        // Most within two days either side of the cutoff, where it matters.
        completed_at: pick(stamps)(NOW - WEEK_MS + (next() - 0.5) * 4 * DAY),
      }))

      const db = clubDatabase(memberships, follows, activities)
      for (const viewer of [null, ...users, 99]) {
        expect(fromSql(db, viewer, NOW)).toEqual(inMemory(db, viewer, NOW))
        for (const club of [1, 2, 3, 4])
          expect(membersFromSql(db, club, viewer, NOW)).toEqual(membersInMemory(db, club, viewer, NOW))
      }
    })
  }
})

describe('the queries', () => {
  it('read the week through the (user_id, completed_at) index', () => {
    const db = clubDatabase([], [], [])
    for (const sql of [clubWeekTotalsSql(3, weekCutoff(NOW)), memberWeekTotalsSql(1, 3, weekCutoff(NOW))]) {
      const plan = (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map(row => row.detail)
        .join('\n')

      expect(plan).toContain('activities_user_completed_index (user_id=? AND completed_at>?)')
      expect(plan).not.toMatch(/SCAN a\b/)
    }
  })

  it('find the odd stamps through the index that holds only them', () => {
    const db = clubDatabase([], [], [])
    for (const sql of [clubWeekStragglersSql(null), clubWeekStragglersSql(3), memberWeekStragglersSql(1, 3)]) {
      const plan = (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map(row => row.detail)
        .join('\n')

      expect(plan).toContain('activities_odd_completed_index (user_id=?)')
    }
  })

  it('leave nothing in the SQL that a viewer id could carry', () => {
    const hostile = '1 OR 1=1' as unknown as number
    for (const sql of [
      clubMembershipSql(hostile),
      clubWeekTotalsSql(hostile, weekCutoff(NOW)),
      clubWeekStragglersSql(hostile),
      memberWeekTotalsSql(hostile, hostile, weekCutoff(NOW)),
      memberWeekStragglersSql(hostile, hostile),
    ])
      expect(sql).not.toContain('1=1')
    expect(clubWeekTotalsSql(1.5, weekCutoff(NOW))).not.toContain('1.5')
  })
})

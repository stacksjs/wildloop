import type { Database } from 'bun:sqlite'
import type { PageParams } from '../../resources/functions/pagination'
import { afterEach, describe, expect, it } from 'bun:test'
import { entrantTallySql, eventDirectory, eventListSql, type EventFilters } from '../../app/Support/eventDirectory'
import { eventPointOf } from '../../app/Support/eventBoard'
import { matchesText, textQuery } from '../../app/Support/textQuery'
import { currentYard, standings } from '../../resources/functions/backyard'
import { paginate } from '../../resources/functions/pagination'
import { seeded } from '../fixtures/clubDatabase'
import { directoryDatabase, insertUsers, planOf } from '../fixtures/directoryDatabase'

/**
 * `GET /api/events` filters in SQL and counts entrants per event in SQL now,
 * for the page it returns. It used to load every event and every entrant and
 * work it all out in memory. That version is kept below as the reference:
 * the same tables go to both, and every page has to come out the same for
 * every viewer and filter.
 */

const NOW = Date.parse('2026-10-03T15:30:12.345Z')
const HOUR = 60 * 60 * 1000

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
  type?: string
  status?: string
  club?: number | null
  q?: string
  page?: PageParams
}

const FIRST_PAGE: PageParams = { offset: 0, limit: 60 }

/** What the action does now, minus the HTTP. */
async function fromSql(db: Database, ask: Ask) {
  const run = async (sql: string) => db.query(sql).all() as any[]
  const filters: EventFilters = { viewer: ask.viewer, type: ask.type, status: ask.status, club: ask.club ?? null, query: textQuery(ask.q) }
  return await eventDirectory(run, filters, ask.page ?? FIRST_PAGE, NOW)
}

const EVENT_TYPES = new Set(['backyard', 'race', 'group_run', 'time_trial'])
const STATUSES = new Set(['scheduled', 'live', 'finished', 'cancelled'])
const STATUS_ORDER: Record<string, number> = { live: 0, scheduled: 1, finished: 2, cancelled: 3 }

/** The action as it was, reading every event and entrant. */
function inMemory(db: Database, ask: Ask) {
  const sessionUser = ask.viewer
  const wantedType = ask.type
  const wantedStatus = ask.status
  const wantedClub = ask.club ?? null
  const query = textQuery(ask.q)

  const all = db.query('SELECT * FROM events').all() as any[]
  const entrants = db.query('SELECT * FROM event_entrants').all() as any[]

  const entrantsByEvent = new Map<number, any[]>()
  for (const entrant of entrants) {
    const list = entrantsByEvent.get(entrant.event_id) ?? []
    list.push(entrant)
    entrantsByEvent.set(entrant.event_id, list)
  }

  const myClubIds = sessionUser === null
    ? new Set<number>()
    : new Set((db.query('SELECT * FROM club_members WHERE user_id = ?').all(sessionUser) as any[]).map((m: any) => m.club_id))

  const visible = all.filter((event: any) => {
    if (event.visibility === 'public')
      return true
    if (sessionUser === null)
      return false
    if (event.host_id === sessionUser)
      return true
    if (event.visibility === 'club')
      return event.club_id !== null && myClubIds.has(event.club_id)
    return (entrantsByEvent.get(event.id) ?? []).some((e: any) => e.user_id === sessionUser)
  })

  const clubIds = [...new Set(visible.map((event: any) => event.club_id).filter(Boolean))] as number[]
  const clubs = clubIds.length ? db.query(`SELECT * FROM clubs WHERE id IN (${clubIds.join(', ')})`).all() as any[] : []
  const clubName = new Map(clubs.map((club: any) => [club.id, club.name]))

  const trailIds = [...new Set(visible
    .filter((event: any) => event.trail_id && (event.latitude == null || event.longitude == null))
    .map((event: any) => event.trail_id))] as number[]
  const trails = trailIds.length ? db.query(`SELECT * FROM trails WHERE id IN (${trailIds.join(', ')})`).all() as any[] : []
  const trailById = new Map(trails.map((trail: any) => [trail.id, trail]))

  const now = NOW
  const rows = visible
    .filter((event: any) => {
      if (wantedType && EVENT_TYPES.has(wantedType) && event.event_type !== wantedType)
        return false
      if (wantedStatus && STATUSES.has(wantedStatus) && event.status !== wantedStatus)
        return false
      if (wantedClub && event.club_id !== wantedClub)
        return false
      return matchesText(query, event.name, event.location)
    })
    .map((event: any) => {
      const field = entrantsByEvent.get(event.id) ?? []
      const schedule = {
        startTime: event.start_time,
        yardMinutes: event.yard_minutes,
        loopDistance: event.loop_distance,
        maxYards: event.max_yards,
      }
      const board = standings(
        field.map((entrant: any) => ({
          userId: entrant.user_id,
          status: entrant.status,
          yardsCompleted: entrant.yards_completed ?? 0,
          lastLapAt: entrant.last_lap_at,
        })),
        schedule,
        now,
      )
      const point = eventPointOf(event, event.trail_id ? trailById.get(event.trail_id) : null)
      return {
        id: event.id,
        name: event.name,
        description: event.description,
        location: event.location,
        lat: point?.lat ?? null,
        lng: point?.lng ?? null,
        type: event.event_type,
        status: event.status,
        visibility: event.visibility,
        hostId: event.host_id,
        clubId: event.club_id,
        clubName: event.club_id ? clubName.get(event.club_id) ?? null : null,
        trailId: event.trail_id,
        loopDistance: event.loop_distance,
        yardMinutes: event.yard_minutes,
        startTime: event.start_time,
        maxYards: event.max_yards,
        winnerId: event.winner_id,
        entrantCount: field.length,
        stillIn: board.filter(entry => entry.stillIn).length,
        currentYard: event.status === 'live' ? currentYard(schedule, now) : 0,
        leaderYards: board[0]?.yardsCompleted ?? 0,
        isEntered: sessionUser !== null && field.some((entrant: any) => entrant.user_id === sessionUser),
        createdAt: event.created_at,
      }
    })
    .sort((a: any, b: any) => {
      const order = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
      if (order !== 0)
        return order
      const aStart = Date.parse(a.startTime)
      const bStart = Date.parse(b.startTime)
      return a.status === 'finished' ? bStart - aStart : aStart - bStart
    })

  const paged = paginate(rows, ask.page ?? FIRST_PAGE)
  return { events: paged.items, meta: paged.meta }
}

interface EventFixture {
  id: number
  host_id: number
  club_id?: number | null
  trail_id?: number | null
  name: string
  location?: string | null
  event_type?: string
  status?: string
  visibility?: string
  start_time: string
  yard_minutes?: number
  latitude?: number | null
  longitude?: number | null
}

function insertEvents(db: Database, events: EventFixture[]): void {
  const insert = db.prepare(`INSERT INTO events (id, host_id, club_id, trail_id, name, description, location, event_type, status, visibility, loop_route, yard_minutes, start_time, latitude, longitude)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const e of events) {
    insert.run(e.id, e.host_id, e.club_id ?? null, e.trail_id ?? null, e.name, `About ${e.name}`, e.location ?? null, e.event_type ?? 'backyard', e.status ?? 'scheduled', e.visibility ?? 'public', '[[0,0],[1,1]]', e.yard_minutes ?? 60, e.start_time, e.latitude ?? null, e.longitude ?? null)
  }
}

function insertEntrants(db: Database, entrants: Array<[event: number, user: number, status: string, yards: number]>): void {
  const insert = db.prepare('INSERT INTO event_entrants (event_id, user_id, status, yards_completed) VALUES (?, ?, ?, ?)')
  for (const [event, user, status, yards] of entrants)
    insert.run(event, user, status, yards)
}

const at = (hours: number) => new Date(NOW + hours * HOUR).toISOString()

describe('the directory, by hand', () => {
  // Host 1 runs a club event for club 7 (member 2) and a private one that 3
  // entered. 4 is nobody in particular.
  const setup = () => {
    const db = open()
    insertUsers(db, [1, 2, 3, 4].map(id => ({ id, name: `User ${id}` })))
    db.run(`INSERT INTO clubs (id, creator_id, name, club_type) VALUES (7, 1, 'Front Range Loopers', 'Running')`)
    db.run(`INSERT INTO club_members (club_id, user_id, role) VALUES (7, 1, 'owner'), (7, 2, 'member')`)
    db.run(`INSERT INTO trails (id, name, latitude, longitude) VALUES (9, 'Mesa Trail', 39.95, -105.28)`)
    insertEvents(db, [
      { id: 1, host_id: 1, name: 'Mesa Backyard', location: 'Boulder, CO', status: 'live', start_time: at(-3.5), trail_id: 9 },
      { id: 2, host_id: 1, name: 'Club Tempo', club_id: 7, visibility: 'club', event_type: 'group_run', start_time: at(48), latitude: 39.7, longitude: -105 },
      { id: 3, host_id: 1, name: 'Invite Only', visibility: 'private', start_time: at(24) },
      { id: 4, host_id: 4, name: 'Old Result', status: 'finished', start_time: at(-500) },
      { id: 5, host_id: 4, name: 'Older Result', status: 'finished', start_time: at(-900) },
    ])
    insertEntrants(db, [
      // In yard 4: 3 yards banked is still in, 2 is out, a winner always is.
      [1, 2, 'running', 3],
      [1, 3, 'running', 2],
      [1, 4, 'registered', 3],
      [1, 5, 'withdrawn', 3],
      [3, 3, 'withdrawn', 0],
      [4, 2, 'winner', 12],
    ])
    return db
  }

  it('lists what someone signed out may see, live first, results newest first', async () => {
    const { events, meta } = await fromSql(setup(), { viewer: null })

    expect(events.map(e => e.id)).toEqual([1, 4, 5])
    expect(events[0]).toMatchObject({
      name: 'Mesa Backyard',
      // From the trail, since the event has no point of its own.
      lat: 39.95,
      lng: -105.28,
      entrantCount: 4,
      stillIn: 2,
      currentYard: 4,
      leaderYards: 3,
      isEntered: false,
      clubName: null,
    })
    expect(events[1]).toMatchObject({ entrantCount: 1, stillIn: 1, leaderYards: 12, currentYard: 0 })
    expect(meta).toEqual({ offset: 0, limit: 60, total: 3, hasMore: false })
  })

  it('shows a club event to its members and a private one to its entrants', async () => {
    const db = setup()

    expect((await fromSql(db, { viewer: 2 })).events.map(e => e.id)).toEqual([1, 2, 4, 5])
    expect((await fromSql(db, { viewer: 2 })).events[1]).toMatchObject({ clubId: 7, clubName: 'Front Range Loopers', lat: 39.7, lng: -105 })
    // Withdrawn, but still an entrant: they keep the result of what they ran.
    expect((await fromSql(db, { viewer: 3 })).events.map(e => [e.id, e.isEntered])).toEqual([[1, true], [3, true], [4, false], [5, false]])
    expect((await fromSql(db, { viewer: 1 })).events.map(e => e.id)).toEqual([1, 3, 2, 4, 5])
    expect((await fromSql(db, { viewer: 4 })).events.map(e => e.id)).toEqual([1, 4, 5])
  })

  it('filters by type, status, club and text', async () => {
    const db = setup()

    expect((await fromSql(db, { viewer: 1, type: 'group_run' })).events.map(e => e.id)).toEqual([2])
    expect((await fromSql(db, { viewer: 1, status: 'finished' })).events.map(e => e.id)).toEqual([4, 5])
    expect((await fromSql(db, { viewer: 1, club: 7 })).events.map(e => e.id)).toEqual([2])
    expect((await fromSql(db, { viewer: 1, q: 'BOULDER' })).events.map(e => e.id)).toEqual([1])
    // Not one of the known values: ignored, as before.
    expect((await fromSql(db, { viewer: null, type: 'marathon', status: 'postponed' })).meta.total).toBe(3)
  })

  it('pages after sorting, and counts every match', async () => {
    const { events, meta } = await fromSql(setup(), { viewer: 1, page: { offset: 1, limit: 2 } })

    expect(events.map(e => e.id)).toEqual([3, 2])
    expect(meta).toEqual({ offset: 1, limit: 2, total: 5, hasMore: true })
  })

  it('agrees with the old in-memory directory', async () => {
    const db = setup()
    for (const viewer of [null, 1, 2, 3, 4, 99]) {
      for (const ask of [{}, { status: 'live' }, { type: 'backyard' }, { club: 7 }, { q: 'result' }, { page: { offset: 2, limit: 2 } }])
        expect(await fromSql(db, { viewer, ...ask })).toEqual(inMemory(db, { viewer, ...ask }))
    }
  })
})

describe('the SQL against the old directory, on mixed data', () => {
  const names = ['Backyard', 'Last Loop', 'Émile\'s Ultra', 'Tempo', 'Time Trial', 'ÉCLAIR Run']
  const places = ['Boulder, CO', 'Denver, CO', 'Chamonix', null]
  const types = ['backyard', 'race', 'group_run', 'time_trial'] as const
  const statuses = ['scheduled', 'live', 'finished', 'cancelled'] as const
  const visibilities = ['public', 'club', 'private'] as const
  const entrantStatuses = ['registered', 'running', 'timed_out', 'withdrawn', 'dnf', 'winner'] as const
  const pages: PageParams[] = [{ offset: 0, limit: 60 }, { offset: 5, limit: 7 }, { offset: 40, limit: 200 }]

  for (const seed of [3, 11, 64, 1001]) {
    it(`matches for every viewer, filter and page (seed ${seed})`, async () => {
      const next = seeded(seed)
      const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]
      const users = [1, 2, 3, 4, 5, 6]

      const db = open()
      insertUsers(db, users.map(id => ({ id, name: `User ${id}` })))
      for (const club of [1, 2, 3]) {
        db.run('INSERT INTO clubs (id, creator_id, name, club_type) VALUES (?, ?, ?, ?)', [club, 1, `Club ${club}`, 'Running'])
        for (const user of users) {
          if (next() < 0.4)
            db.run('INSERT INTO club_members (club_id, user_id, role) VALUES (?, ?, ?)', [club, user, 'member'])
        }
      }
      db.run(`INSERT INTO trails (id, name, latitude, longitude) VALUES (1, 'A', 39.9, -105.2), (2, 'B', NULL, NULL), (3, 'C', 0, 0)`)

      const events: EventFixture[] = Array.from({ length: 50 }, (_, i) => {
        const placed = next() < 0.5
        return {
          id: i + 1,
          host_id: pick(users),
          club_id: next() < 0.6 ? pick([1, 2, 3, 4]) : null,
          trail_id: next() < 0.4 ? pick([1, 2, 3, 77]) : null,
          name: `${pick(names)} ${i}`,
          location: pick(places),
          event_type: pick(types),
          status: pick(statuses),
          visibility: pick(visibilities),
          // Equal start times and a few unreadable ones, so the sort's ties
          // and its NaN comparisons are exercised.
          start_time: next() < 0.06 ? 'TBD' : at(Math.round((next() - 0.5) * 20) * 3),
          yard_minutes: pick([60, 30, 0]),
          latitude: placed ? 39 + next() : null,
          longitude: placed && next() < 0.9 ? -105 + next() : null,
        }
      })
      insertEvents(db, events)
      const entrants: Array<[number, number, string, number]> = []
      for (const event of events) {
        for (const user of users) {
          if (next() < 0.35)
            entrants.push([event.id, user, pick(entrantStatuses), Math.floor(next() * 12)])
        }
      }
      insertEntrants(db, entrants)

      for (const viewer of [null, ...users, 99]) {
        for (const filter of [{}, { status: 'live' }, { status: 'finished' }, { type: 'race' }, { club: 2 }, { q: 'backyard' }, { q: 'émile' }, { q: 'co' }, { type: 'nope', status: 'scheduled', club: 4 }]) {
          for (const page of pages)
            expect(await fromSql(db, { viewer, ...filter, page })).toEqual(inMemory(db, { viewer, ...filter, page }))
        }
      }
    })
  }
})

describe('the queries', () => {
  it('decide visibility through the unique indexes, never a scan of members or entrants', () => {
    const plan = planOf(open(), eventListSql({ viewer: 3, query: '' }))

    expect(plan).toMatch(/club_members_club_user_unique \(club_id=\? AND user_id=\?\)/)
    expect(plan).toMatch(/event_entrants_event_user_unique \(event_id=\? AND user_id=\?\)/)
    expect(plan).not.toMatch(/SCAN (m|x)\b/)
  })

  it('read a status straight from its index', () => {
    expect(planOf(open(), eventListSql({ viewer: null, status: 'live', query: '' }))).toContain('events_status_start_index (status=?)')
  })

  it('count only the page\'s entrants, by event', () => {
    const plan = planOf(open(), entrantTallySql([1, 2, 3], 4) as string)

    expect(plan).toMatch(/SEARCH event_entrants USING .*INDEX event_entrants_\w+ \(event_id=\?\)/)
  })

  it('leave nothing in the SQL that a caller could carry', () => {
    const hostile = '1 OR 1=1' as unknown as number
    const sql = [
      eventListSql({ viewer: hostile, type: 'race\' OR \'1\'=\'1', status: 'live; DROP TABLE events', club: hostile, query: '' }),
      entrantTallySql([hostile, 2], hostile) as string,
    ].join('\n')

    expect(sql).not.toContain('1=1')
    expect(sql).not.toContain('DROP')
    expect(sql).not.toContain('\'1\'')
  })
})

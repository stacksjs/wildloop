import type { Database } from 'bun:sqlite'
import type { FoldStore } from '../../app/Support/trailFolding'
import type { WholeTrailMember } from '../../app/Support/wholeTrail'
import type { TrailFixture } from '../fixtures/trailCatalogDatabase'
import { afterEach, describe, expect, it } from 'bun:test'
import { fillWholeTrails, foldNames, releaseStaleFolds } from '../../app/Support/trailFolding'
import { WHOLE_AT_LEAST_SQL, WHOLE_AT_MOST_SQL, wholeTrail, withWholeTrail } from '../../app/Support/wholeTrail'
import { insertTrails, trailCatalogDatabase } from '../fixtures/trailCatalogDatabase'

/**
 * A trail folded from pieces is as long as its pieces together (#1002).
 *
 * `wholeTrail` adds them up without counting the same ground twice, and the
 * fold keeps the answer in `trail_totals` (migration 0000000200) — checked
 * here against the catalog as the migrations build it.
 */

/** A line north from (lat, lng), `miles` long, a point every tenth of a mile. */
function north(lat: number, lng: number, miles: number): Array<[number, number]> {
  const steps = Math.max(1, Math.round(miles * 10))
  return Array.from({ length: steps + 1 }, (_, i) => [lat + (miles * i / steps) / 69, lng] as [number, number])
}

/** A line east from (lat, lng), `miles` long. */
function east(lat: number, lng: number, miles: number): Array<[number, number]> {
  const steps = Math.max(1, Math.round(miles * 10))
  const perMile = 1 / (69 * Math.cos(lat * Math.PI / 180))
  return Array.from({ length: steps + 1 }, (_, i) => [lat, lng + miles * perMile * i / steps] as [number, number])
}

function member(id: number, line: Array<[number, number]>, distance: number, elevation = 0, measured = true): WholeTrailMember {
  return { id, distance, elevation, elevationMeasured: measured, lines: [line.map(([lat, lng]) => ({ lat, lng }))] }
}

const LAT = 39.95
const LNG = -105.26

describe('wholeTrail', () => {
  it('is the trail itself when nothing folded into it', () => {
    expect(wholeTrail(member(1, north(LAT, LNG, 1.14), 1.14, 300), [])).toEqual({ distance: 1.14, elevation: 300, pieces: 0 })
  })

  it('adds pieces that continue the trail end to end', () => {
    const kept = member(1, north(LAT, LNG, 2), 2, 400)
    const after = member(2, north(LAT + 2 / 69, LNG, 0.3), 0.3, 50)
    const before = member(3, north(LAT - 0.4 / 69, LNG, 0.4), 0.4, 80)

    expect(wholeTrail(kept, [after, before])).toEqual({ distance: 2.7, elevation: 530, pieces: 2 })
  })

  it('adds a branch that leaves the trail partway along', () => {
    const kept = member(1, north(LAT, LNG, 2), 2)
    const spur = member(2, east(LAT + 1 / 69, LNG, 0.5), 0.5)

    expect(wholeTrail(kept, [spur]).distance).toBe(2.5)
  })

  it('counts a way drawn twice once', () => {
    const kept = member(1, north(LAT, LNG, 2), 2)
    const way = north(LAT + 2 / 69, LNG, 0.3)

    expect(wholeTrail(kept, [member(2, way, 0.3), member(3, way, 0.3)]).distance).toBe(2.3)
    // Drawn the other way round, it is still the same ground.
    expect(wholeTrail(kept, [member(2, way, 0.3), member(3, [...way].reverse(), 0.3)]).distance).toBe(2.3)
  })

  it('counts nothing for a piece that repeats the kept line', () => {
    const line = north(LAT, LNG, 2)
    expect(wholeTrail(member(1, line, 2), [member(2, line, 2)])).toMatchObject({ distance: 2, pieces: 1 })
  })

  it('counts nothing for the ways a kept route relation is made of', () => {
    // The relation is the longest row, so it is the one kept, and its member
    // ways share its name and fold into it.
    const relation = member(1, north(LAT, LNG, 0.6), 0.6)
    const first = member(2, north(LAT, LNG, 0.3), 0.3)
    const second = member(3, north(LAT + 0.3 / 69, LNG, 0.3), 0.3)

    expect(wholeTrail(relation, [first, second]).distance).toBe(0.6)
  })

  it('counts only the part of a piece that is new ground', () => {
    const kept = member(1, north(LAT, LNG, 1), 1)
    // Starts half a mile up the trail and runs on half a mile past its end.
    const overlapping = member(2, north(LAT + 0.5 / 69, LNG, 1), 1)

    expect(wholeTrail(kept, [overlapping]).distance).toBeCloseTo(1.5, 1)
  })

  it('gives no ascent when a piece that adds length has none measured', () => {
    const kept = member(1, north(LAT, LNG, 2), 2, 400)
    const unmeasured = member(2, north(LAT + 2 / 69, LNG, 0.3), 0.3, 0, false)

    expect(wholeTrail(kept, [unmeasured])).toEqual({ distance: 2.3, elevation: null, pieces: 1 })
  })
})

describe('withWholeTrail', () => {
  it('shows the whole trail and keeps the row beside it', () => {
    const row = { id: 1, distance: 1.14, elevation: 300, geometry: '[]' }
    expect(withWholeTrail(row, { distance: 4.2, elevation: 900, pieces: 3 })).toEqual({
      id: 1,
      distance: 4.2,
      elevation: 900,
      ownDistance: 1.14,
      ownElevation: 300,
      pieces: 3,
      geometry: '[]',
    })
  })

  it('keeps the row ascent when the whole one was not measured', () => {
    expect(withWholeTrail({ id: 1, distance: 1, elevation: 300 }, { distance: 2, elevation: null, pieces: 1 }).elevation).toBe(300)
  })

  it('leaves a trail without pieces as it is', () => {
    const row = { id: 1, distance: 1.14 }
    expect(withWholeTrail(row, undefined)).toBe(row)
  })
})

let database: Database | null = null
afterEach(() => {
  database?.close()
  database = null
})

function store(db: Database): FoldStore {
  return {
    sql: async (strings: TemplateStringsArray, ...values: unknown[]) => db.query(strings.join('?')).all(...(values as any[])) as any[],
    transaction: async <T>(work: () => Promise<T>): Promise<T> => {
      db.run('BEGIN IMMEDIATE')
      try {
        const result = await work()
        db.run('COMMIT')
        return result
      }
      catch (error) {
        db.run('ROLLBACK')
        throw error
      }
    },
  }
}

/** Mesa Trail as production has it: the whole trail and two ways continuing it. */
const MESA: TrailFixture[] = [
  { id: 1, name: 'Mesa Trail', line: north(LAT, LNG, 2), distance: 2 },
  { id: 2, name: 'Mesa Trail', line: north(LAT + 2 / 69, LNG, 0.3), distance: 0.3 },
  { id: 3, name: 'Mesa Trail', line: north(LAT - 0.4 / 69, LNG, 0.4), distance: 0.4 },
  { id: 4, name: 'Bear Peak', line: north(39.96, -105.29, 3), distance: 3 },
]

const totals = (db: Database) => db.query('SELECT trail_id, distance, pieces, country FROM trail_totals ORDER BY trail_id').all()

describe('the fold keeps whole lengths', () => {
  it('writes the whole trail with the pieces it adds up', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, MESA)

    const outcome = await foldNames(['Mesa Trail', 'Bear Peak'], {}, store(database))

    expect(outcome.totals.get(1)?.distance).toBe(2.7)
    expect(totals(database)).toEqual([{ trail_id: 1, distance: 2.7, pieces: 2, country: 'US' }])
    const place = database.query('SELECT latitude, longitude FROM trail_totals WHERE trail_id = 1').get() as any
    expect(place).toEqual({ latitude: LAT, longitude: LNG })
  })

  it('drops the total when the trail no longer has pieces', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, MESA)
    await foldNames(['Mesa Trail'], {}, store(database))

    // A re-sync renames both ways: the trail stands alone again.
    database.run(`UPDATE trails SET name = 'Mesa Trail Spur' WHERE id IN (2, 3)`)
    await releaseStaleFolds(store(database))

    expect(totals(database)).toEqual([])
  })

  it('works the total out again from the pieces a trail has left', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, MESA)
    await foldNames(['Mesa Trail'], {}, store(database))

    database.run(`UPDATE trails SET name = 'Mesa Trail Spur' WHERE id = 3`)
    await releaseStaleFolds(store(database))
    expect(totals(database)).toEqual([])

    expect(await fillWholeTrails({}, store(database))).toEqual({ filled: 1, done: true })
    expect(totals(database)).toEqual([{ trail_id: 1, distance: 2.3, pieces: 1, country: 'US' }])
  })

  it('fills trails folded before there were totals, a batch at a time, from where it stopped', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, [
      ...MESA,
      { id: 5, name: 'Bear Peak', line: north(39.96 + 3 / 69, -105.29, 1), distance: 1 },
    ])
    database.run(`INSERT INTO trail_parts (trail_id, part_of, country, folded_at) VALUES (2, 1, 'US', 'then'), (3, 1, 'US', 'then'), (5, 4, 'US', 'then')`)

    expect(await fillWholeTrails({ limit: 1 }, store(database))).toEqual({ filled: 1, done: false })
    expect(totals(database)).toEqual([{ trail_id: 1, distance: 2.7, pieces: 2, country: 'US' }])

    expect(await fillWholeTrails({ limit: 1 }, store(database))).toEqual({ filled: 1, done: false })
    expect(await fillWholeTrails({}, store(database))).toEqual({ filled: 0, done: true })
    expect(totals(database)).toEqual([
      { trail_id: 1, distance: 2.7, pieces: 2, country: 'US' },
      { trail_id: 4, distance: 4, pieces: 1, country: 'US' },
    ])
  })
})

describe('the catalog filters on the whole trail', () => {
  /** Ids of the trails a length filter keeps, as TrailIndexAction applies it. */
  async function lengths(where: string, ...bound: number[]): Promise<number[]> {
    database = database ?? trailCatalogDatabase()
    return (database.query(`SELECT id FROM trails WHERE id NOT IN (SELECT trail_id FROM trail_parts) AND ${where} ORDER BY id`).all(...bound) as any[]).map(row => row.id)
  }

  it('finds a trail longer than its own row by its pieces', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, MESA)
    await foldNames(['Mesa Trail'], {}, store(database))

    // Mesa Trail is 2 miles on its own row and 2.7 whole; Bear Peak is 3.
    expect(await lengths(WHOLE_AT_LEAST_SQL.distance, 2.5, 2.5)).toEqual([1, 4])
    expect(await lengths(WHOLE_AT_LEAST_SQL.distance, 2.8, 2.8)).toEqual([4])
    expect(await lengths(WHOLE_AT_MOST_SQL.distance, 2.5, 2.5)).toEqual([])
    expect(await lengths(WHOLE_AT_MOST_SQL.distance, 2.7, 2.7)).toEqual([1])
    expect(await lengths(WHOLE_AT_MOST_SQL.distance, 3, 3)).toEqual([1, 4])
  })
})

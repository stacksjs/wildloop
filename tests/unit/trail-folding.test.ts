import type { Database } from 'bun:sqlite'
import type { FoldStore } from '../../app/Support/trailFolding'
import type { TrailFixture } from '../fixtures/trailCatalogDatabase'
import { afterEach, describe, expect, it } from 'bun:test'
import { foldNames, foldProgress, nextSharedNames, releaseStaleFolds } from '../../app/Support/trailFolding'
import { NOT_FOLDED_SQL } from '../../app/Support/trailFragments'
import { insertTrails, trailCatalogDatabase } from '../fixtures/trailCatalogDatabase'

/**
 * Folding way fragments, against the catalog as the migrations build it.
 *
 * `trailFolding.ts` runs every statement through a store, which is the ORM's
 * connection in production and an in-memory SQLite here — the same statements
 * with the same values, against `trail_parts` from migration 0000000190 and
 * the trails table with every column and index it has in production.
 */

let database: Database | null = null
afterEach(() => {
  database?.close()
  database = null
})

function store(db: Database): FoldStore & { writes: number } {
  const run = {
    writes: 0,
    sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join('?')
      if (/^\s*(?:INSERT|UPDATE|DELETE)/i.test(text))
        run.writes++
      return db.query(text).all(...(values as any[])) as any[]
    },
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
  return run
}

/** A run north from (lat, lng), `miles` long. */
function run(lat: number, lng: number, miles: number): Array<[number, number]> {
  return [[lat, lng], [lat + miles / 138, lng], [lat + miles / 69, lng]]
}

/**
 * Mesa Trail in Boulder as production has it: the whole trail and the
 * quarter-mile ways it was also drawn as. Red Trail twice, in two parks.
 */
const BOULDER: TrailFixture[] = [
  { id: 1, name: 'Mesa Trail', line: run(39.95, -105.26, 2), distance: 2 },
  { id: 2, name: 'Mesa Trail', line: run(39.95 + 2 / 69, -105.26, 0.3), distance: 0.3 },
  { id: 3, name: 'Mesa Trail', line: run(39.95 - 0.4 / 69, -105.26, 0.4), distance: 0.4 },
  { id: 4, name: 'Red Trail', line: run(40.1, -105.3, 0.5), distance: 0.5 },
  { id: 5, name: 'Red Trail', line: run(44.05, -121.3, 0.5), distance: 0.5 },
  { id: 6, name: 'Bear Peak', line: run(39.96, -105.29, 3), distance: 3 },
]

const parts = (db: Database) => db.query('SELECT trail_id, part_of, country FROM trail_parts ORDER BY trail_id').all()

describe('foldNames', () => {
  it('records the pieces of a trail, and nothing about trails that only share a name', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, BOULDER)

    const outcome = await foldNames(['Mesa Trail', 'Red Trail', 'Bear Peak'], {}, store(database))

    expect(parts(database)).toEqual([
      { trail_id: 2, part_of: 1, country: 'US' },
      { trail_id: 3, part_of: 1, country: 'US' },
    ])
    expect(outcome).toMatchObject({ names: 3, rows: 6, folded: 2, unfolded: 0, skipped: 0 })
  })

  it('writes nothing the second time', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, BOULDER)
    await foldNames(['Mesa Trail'], {}, store(database))

    const again = store(database)
    const outcome = await foldNames(['Mesa Trail'], {}, again)
    expect(outcome).toMatchObject({ folded: 0, unfolded: 0 })
    expect(again.writes).toBe(0)
  })

  it('writes nothing on a dry run', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, BOULDER)
    const outcome = await foldNames(['Mesa Trail'], { dryRun: true }, store(database))
    expect(outcome.folds.size).toBe(2)
    expect(parts(database)).toEqual([])
  })

  it('never folds a row people reviewed or photographed', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, BOULDER.map(t => (t.id === 2 ? { ...t, reviewCount: 1 } : t)))
    database.run(`INSERT INTO users (id, name, email) VALUES (1, 'Ana', 'ana@example.test')`)
    database.run(`INSERT INTO trail_photos (uuid, trail_id, user_id, storage_key, thumb_key, width, height, bytes, status)
      VALUES ('p1', 3, 1, 'k', 't', 1, 1, 1, 'visible')`)

    await foldNames(['Mesa Trail'], {}, store(database))
    expect(parts(database)).toEqual([])
  })

  it('lists a piece again once it no longer joins the trail', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, BOULDER)
    await foldNames(['Mesa Trail'], {}, store(database))

    // A re-sync moves the line of row 3 a long way off.
    database.run(`UPDATE trails SET geometry = ?, latitude = 41.5 WHERE id = 3`, [JSON.stringify(run(41.5, -105.26, 0.4))])
    const outcome = await foldNames(['Mesa Trail'], {}, store(database))

    expect(outcome.unfolded).toBe(1)
    expect(parts(database)).toEqual([{ trail_id: 2, part_of: 1, country: 'US' }])
  })

  it('leaves a name with more rows than the bound alone', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, BOULDER)
    const outcome = await foldNames(['Mesa Trail'], { maxRows: 2 }, store(database))
    expect(outcome.skipped).toBe(1)
    expect(parts(database)).toEqual([])
  })

  it('records where the walk is up to with the batch, and starts over after the last name', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, BOULDER)
    const db = store(database)

    await foldNames(['Mesa Trail'], { progress: { afterName: 'Mesa Trail', passed: false } }, db)
    expect(await foldProgress(db)).toEqual({ afterName: 'Mesa Trail', passes: 0 })

    await foldNames(['Red Trail'], { progress: { afterName: 'Red Trail', passed: true } }, db)
    expect(await foldProgress(db)).toEqual({ afterName: '', passes: 1 })
  })
})

describe('releaseStaleFolds', () => {
  it('lists a piece again when it or its trail is renamed', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, BOULDER)
    await foldNames(['Mesa Trail'], {}, store(database))

    database.run(`UPDATE trails SET name = 'Mesa Trail Spur' WHERE id = 2`)
    expect(await releaseStaleFolds(store(database))).toBe(1)
    expect(parts(database)).toEqual([{ trail_id: 3, part_of: 1, country: 'US' }])
  })

  it('leaves the pieces that still hold alone', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, BOULDER)
    await foldNames(['Mesa Trail'], {}, store(database))
    expect(await releaseStaleFolds(store(database))).toBe(0)
    expect(parts(database)).toHaveLength(2)
  })
})

describe('nextSharedNames', () => {
  it('walks only the names on more than one row, in name order, after the last one done', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, BOULDER)
    const db = store(database)

    expect(await nextSharedNames('', 10, db)).toEqual(['Mesa Trail', 'Red Trail'])
    expect(await nextSharedNames('Mesa Trail', 10, db)).toEqual(['Red Trail'])
    expect(await nextSharedNames('', 1, db)).toEqual(['Mesa Trail'])
  })

  it('reads the name index and nothing else', () => {
    database = trailCatalogDatabase()
    const plan = (database.query(`EXPLAIN QUERY PLAN SELECT name FROM trails WHERE name > ? GROUP BY name HAVING COUNT(*) > 1 ORDER BY name LIMIT 200`).all('') as any[])
      .map(row => row.detail)
      .join(' | ')
    expect(plan).toContain('COVERING INDEX trails_name_index')
    expect(plan).not.toContain('TEMP B-TREE')
  })
})

/*
 * The catalog leaves pieces out with `NOT_FOLDED_SQL`. It must never cost a
 * query the index it planned on before: these run with enough rows, and
 * statistics, for the plan to be the one production faces.
 */
describe('the catalog filter', () => {
  function bigCatalog(): Database {
    const db = trailCatalogDatabase()
    const rows: TrailFixture[] = []
    for (let i = 1; i <= 6000; i++) {
      const lat = 30 + (i % 97) * 0.2
      rows.push({ id: i, name: `Trail ${i % 1500}`, line: run(lat, -110 + (i % 89) * 0.2, 0.5), distance: (i % 40) / 4, country: i % 4 === 0 ? 'DE' : 'US' })
    }
    insertTrails(db, rows)
    db.run(`INSERT INTO trail_parts (trail_id, part_of, country, folded_at) SELECT id, id - 1, country, 'now' FROM trails WHERE id % 3 = 0`)
    db.run('ANALYZE')
    return db
  }

  const plan = (db: Database, sql: string): string =>
    (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as any[]).map(row => row.detail).join(' | ')

  it('keeps the count by country covered by its index', () => {
    database = bigCatalog()
    const detail = plan(database, `SELECT COUNT(*) FROM trails WHERE country = 'US' AND ${NOT_FOLDED_SQL}`)
    expect(detail).toContain('COVERING INDEX')
    expect(detail).toContain('USING ROWID SEARCH ON TABLE trail_parts')
  })

  it('keeps near me on the latitude index', () => {
    database = bigCatalog()
    const detail = plan(database, `SELECT id FROM trails WHERE latitude >= 39 AND latitude <= 40 AND longitude >= -106 AND longitude <= -105 AND ${NOT_FOLDED_SQL}`)
    expect(detail).toContain('trails_lat_lng_index')
  })

  it('keeps the name sort on the name index', () => {
    database = bigCatalog()
    const detail = plan(database, `SELECT * FROM trails WHERE ${NOT_FOLDED_SQL} ORDER BY name LIMIT 50 OFFSET 1000`)
    expect(detail).toContain('trails_name_index')
    expect(detail).not.toContain('TEMP B-TREE')
  })

  /*
   * The catalog's opening count is the covered count less the pieces, read
   * from the country `trail_parts` keeps (TrailIndexAction `countListed`).
   * It has to agree with the filter it stands in for.
   */
  it('counts the same by subtraction as by filtering', () => {
    database = bigCatalog()
    for (const country of ['US', 'DE']) {
      const filtered = (database.query(`SELECT COUNT(*) AS n FROM trails WHERE country = ? AND ${NOT_FOLDED_SQL}`).get(country) as any).n
      const rows = (database.query('SELECT COUNT(*) AS n FROM trails WHERE country = ?').get(country) as any).n
      const pieces = (database.query('SELECT COUNT(*) AS n FROM trail_parts WHERE country = ?').get(country) as any).n
      expect(rows - pieces).toBe(filtered)
    }
    const everywhere = (database.query(`SELECT COUNT(*) AS n FROM trails WHERE ${NOT_FOLDED_SQL}`).get() as any).n
    const all = (database.query('SELECT (SELECT COUNT(*) FROM trails) - (SELECT COUNT(*) FROM trail_parts) AS n').get() as any).n
    expect(all).toBe(everywhere)
  })

  it('takes nothing away from a trail that is not a piece', async () => {
    database = trailCatalogDatabase()
    insertTrails(database, BOULDER)
    await foldNames(['Mesa Trail', 'Red Trail'], {}, store(database))
    const listed = (database.query(`SELECT id FROM trails WHERE ${NOT_FOLDED_SQL} ORDER BY id`).all() as any[]).map(row => row.id)
    expect(listed).toEqual([1, 4, 5, 6])
  })
})

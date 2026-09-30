import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'

/**
 * Sorting the catalog by name, and the index that makes it possible.
 *
 * Without one, `ORDER BY name` sorted all 596,556 rows before it could skip to
 * the offset. On production that took 6.7s at offset 60,000 and crossed the
 * edge timeout past 120,000, coming back as HTTP 520 rather than as a slow
 * page (#1008).
 *
 * An index is only a fix if the query planner picks it, and a planner picks by
 * cost — on a handful of rows it will scan and sort regardless, so testing
 * this on a toy table proves nothing. These run against enough rows for the
 * choice to be the one production faces, and assert the plan itself rather
 * than a wall-clock time that would be flaky on a loaded machine.
 */

const INDEX_MIGRATION = 'database/migrations/0000000176-alter-trails-name-index.sql'

/** Rows enough that a full sort is plainly the more expensive plan. */
const ROWS = 20_000

async function catalog(withIndex: boolean): Promise<Database> {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE "trails" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "distance" REAL NOT NULL DEFAULT 0,
    "country" TEXT
  )`)

  const insert = db.prepare('INSERT INTO trails (name, distance, country) VALUES (?, ?, ?)')
  const many = db.transaction((count: number) => {
    for (let i = 0; i < count; i++) {
      // Names out of order on purpose: an index has to earn the ordering.
      insert.run(`Trail ${(i * 7919) % count}`, (i % 40) / 2, i % 3 === 0 ? 'US' : 'DE')
    }
  })
  many(ROWS)

  if (withIndex) {
    const sql = await Bun.file(INDEX_MIGRATION).text()
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean))
      db.run(statement)
  }

  // Planners choose on statistics, and production has them.
  db.run('ANALYZE')
  return db
}

const plan = (db: Database, sql: string): string =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all() as any[]).map(r => r.detail).join(' | ')

describe('ORDER BY name', () => {
  /*
   * The shape of the bug: without an index the planner has to materialise and
   * sort the whole table before it can honour the offset, and that is what
   * grew past the timeout as paging went deeper.
   */
  it('sorts the whole table when nothing indexes the name', async () => {
    const db = await catalog(false)
    expect(plan(db, 'SELECT * FROM trails ORDER BY name LIMIT 50 OFFSET 60000')).toContain('USE TEMP B-TREE FOR ORDER BY')
  })

  /*
   * The fix, and the thing I said in #1008 needed confirming before the issue
   * could be closed: an index is only a fix if the planner picks it.
   */
  it('walks the index instead, once there is one', async () => {
    const db = await catalog(true)
    const detail = plan(db, 'SELECT * FROM trails ORDER BY name LIMIT 50 OFFSET 60000')

    expect(detail).toContain('trails_name_index')
    expect(detail).not.toContain('USE TEMP B-TREE FOR ORDER BY')
  })

  it('still walks it at the depth that returned 520', async () => {
    const db = await catalog(true)
    for (const offset of [0, 60_000, 120_000, 300_000]) {
      const detail = plan(db, `SELECT * FROM trails ORDER BY name LIMIT 50 OFFSET ${offset}`)
      expect(detail, `offset ${offset}`).not.toContain('USE TEMP B-TREE FOR ORDER BY')
    }
  })

  it('returns the same rows it did before', async () => {
    // An index must not change the answer, only the route to it.
    const plain = await catalog(false)
    const indexed = await catalog(true)
    const read = (db: Database) =>
      (db.query('SELECT name FROM trails ORDER BY name LIMIT 20 OFFSET 5000').all() as any[]).map(r => r.name)

    expect(read(indexed)).toEqual(read(plain))
  })

  /*
   * Honest about what this does not fix.
   *
   * Deep OFFSET is linear whatever the plan: the engine still walks past every
   * skipped row, it just walks an index rather than sorting the table first.
   * Paging to the far end stays work, and keyset paging is the answer if it
   * ever has to be cheap.
   */
  it('does not pretend to make a deep offset free', async () => {
    const db = await catalog(true)
    expect(plan(db, 'SELECT * FROM trails ORDER BY name LIMIT 50 OFFSET 300000')).toContain('SCAN')
  })
})

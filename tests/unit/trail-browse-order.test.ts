import type { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import Trail from '../../app/Models/Trail'
import { FEATURED_ORDER } from '../../app/Support/catalogOrder'
import { NOT_FOLDED_SQL } from '../../app/Support/trailFragments'
import { trailCatalogDatabase } from '../fixtures/trailCatalogDatabase'

/**
 * The page the catalog opens on, for somebody who has not said where they are.
 *
 * Ordered by `FEATURED_ORDER`, which no index held in full: SQLite walked
 * `trails_browse_band_index` as far as rating and sorted the rest of every
 * band, 550 ms to 3.3 s on a 596,556-row copy against 2 ms near somebody.
 * Migration 0000000199 indexes the whole order, everywhere and by country.
 *
 * A planner picks by cost, so these run on enough rows, analysed, for the
 * choice to be the one production faces, against the real migrations, and
 * assert the plan rather than a time. The query is the one the ORM builds.
 */

const ROWS = 20_000

let db: Database

beforeAll(() => {
  db = trailCatalogDatabase()
  const insert = db.prepare(`INSERT INTO trails
    (id, name, location, distance, elevation, difficulty, rating, review_count, national_trail, latitude, longitude, geometry, uuid, source, source_id, country, state)
    VALUES (?, ?, 'Somewhere', ?, 0, 'easy', 0, 0, ?, ?, ?, '[[0,0],[0.001,0.001]]', ?, 'osm', ?, ?, ?)`)
  const part = db.prepare(`INSERT INTO trail_parts (trail_id, part_of, country, folded_at) VALUES (?, ?, ?, 'then')`)
  db.transaction(() => {
    for (let id = 1; id <= ROWS; id++) {
      const country = id % 5 === 0 ? 'DE' : 'US'
      // Lengths spread over every band, out of id order.
      const miles = ((id * 7919) % 4000) / 100
      insert.run(id, `Trail ${id}`, miles, id % 500 === 0 ? 1 : 0, 39 + (id % 100) / 100, -105 + (id % 77) / 100, `uuid-${id}`, `way/${id}`, country, country === 'US' ? 'CO' : 'DE-BY')
      // A piece in every four, as production has about one in three and a half.
      if (id % 4 === 0)
        part.run(id, id - 1, country)
    }
  })()
  db.run('ANALYZE')
})

afterAll(() => db?.close())

function featured(country?: string, offset = 0): { sql: string, params: unknown[] } {
  let query: any = (Trail as any).query().whereRaw(NOT_FOLDED_SQL)
  if (country)
    query = query.where('country', country)
  for (const [column, direction] of FEATURED_ORDER)
    query = query.orderBy(column, direction)
  return query.limit(200).offset(offset).toSql()
}

const plan = ({ sql, params }: { sql: string, params: unknown[] }): string =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as any[])) as any[]).map(row => row.detail).join(' | ')

describe('the first page of the catalog', () => {
  it('is ordered exactly as the index is', () => {
    // index_xinfo lists the key columns, then the rowid the index ends on.
    const columns = (name: string) => (db.query(`PRAGMA index_xinfo(${name})`).all() as any[])
      .filter(row => row.key)
      .map(row => [row.cid === -1 ? 'id' : row.name, row.desc ? 'desc' : 'asc'])
    const order = FEATURED_ORDER.filter(([column]) => column !== 'id').map(([column, direction]) => [column, direction])

    expect(columns('trails_browse_order_index')).toEqual(order)
    expect(columns('trails_country_browse_order_index')).toEqual([['country', 'asc'], ...order])
    // id last and ascending: the rowid every index entry already ends on.
    expect(FEATURED_ORDER[FEATURED_ORDER.length - 1]).toEqual(['id', 'asc'])
  })

  it('walks the index everywhere instead of sorting the catalog', () => {
    const detail = plan(featured())
    expect(detail).toContain('trails_browse_order_index')
    expect(detail).not.toContain('TEMP B-TREE')
  })

  it('walks the country index for one country, the list the catalog opens on', () => {
    for (const country of ['US', 'DE']) {
      const detail = plan(featured(country))
      expect(detail, country).toContain('trails_country_browse_order_index (country=?)')
      expect(detail, country).not.toContain('TEMP B-TREE')
    }
  })

  it('still walks it a few pages in', () => {
    expect(plan(featured('US', 2000))).not.toContain('TEMP B-TREE')
  })

  it('still leaves out the pieces of other trails, a lookup per row walked', () => {
    expect(plan(featured('US'))).toContain('USING ROWID SEARCH ON TABLE trail_parts FOR IN-OPERATOR')

    const { sql, params } = featured('US')
    const ids = (db.query(sql).all(...(params as any[])) as any[]).map(row => Number(row.id))
    expect(ids).toHaveLength(200)
    expect(ids.some(id => id % 4 === 0)).toBe(false)
  })

  it('returns the rows a full sort would', () => {
    const { sql, params } = featured('US')
    const indexed = (db.query(sql).all(...(params as any[])) as any[]).map(row => row.id)
    const sorted = (db.query(sql.replace('FROM trails', 'FROM trails NOT INDEXED')).all(...(params as any[])) as any[]).map(row => row.id)
    expect(indexed).toEqual(sorted)
  })

  it('keeps the count it opens with covered: rows by country, less the pieces there', () => {
    expect(plan({ sql: 'SELECT COUNT(*) FROM trails WHERE country = ?', params: ['US'] })).toContain('COVERING INDEX')
    expect(plan({ sql: 'SELECT COUNT(*) FROM trail_parts WHERE country = ?', params: ['US'] })).toContain('COVERING INDEX trail_parts_country_index')
  })

  it('drops the index it replaces', () => {
    expect(db.query(`SELECT name FROM sqlite_master WHERE name = 'trails_browse_band_index'`).get()).toBeNull()
  })
})

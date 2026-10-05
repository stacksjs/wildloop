import type { Database } from 'bun:sqlite'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import Trail from '../../app/Models/Trail'
import { NAME_ORDER, POPULAR_ORDER, RATING_ORDER } from '../../app/Support/catalogOrder'
import { NOT_FOLDED_SQL } from '../../app/Support/trailFragments'
import { trailCatalogDatabase } from '../fixtures/trailCatalogDatabase'

/**
 * Top rated, popular and A to Z, for somebody who has not said where they are.
 *
 * Each read every row of the country, or of the catalog, and sorted it: on a
 * 596,556-row copy built from the migrations, 300 to 870 ms warm and 4.9 s
 * cold, against about a millisecond for the order the catalog opens on.
 * Migration 0000000202 gives each its index, everywhere and by country, as
 * `trail-browse-order.test.ts` does for the default.
 *
 * As there, the rows are enough, and analysed, for the planner to choose what
 * production faces, and the plan is asserted rather than a time. The query is
 * the one the ORM builds.
 */

const ROWS = 20_000

type Order = ReadonlyArray<readonly [string, 'asc' | 'desc']>

const ORDERS: Array<{ sort: string, order: Order, everywhere: string, byCountry: string }> = [
  { sort: 'rating', order: RATING_ORDER, everywhere: 'trails_rating_order_index', byCountry: 'trails_country_rating_order_index' },
  { sort: 'popular', order: POPULAR_ORDER, everywhere: 'trails_popular_order_index', byCountry: 'trails_country_popular_order_index' },
  { sort: 'name', order: NAME_ORDER, everywhere: 'trails_name_index', byCountry: 'trails_country_name_index' },
]

let db: Database

beforeAll(() => {
  db = trailCatalogDatabase()
  const insert = db.prepare(`INSERT INTO trails
    (id, name, location, distance, elevation, difficulty, rating, review_count, national_trail, latitude, longitude, geometry, uuid, source, source_id, country, state)
    VALUES (?, ?, 'Somewhere', ?, 0, 'easy', ?, ?, 0, ?, ?, '[[0,0],[0.001,0.001]]', ?, 'osm', ?, ?, ?)`)
  const part = db.prepare(`INSERT INTO trail_parts (trail_id, part_of, country, folded_at) VALUES (?, ?, ?, 'then')`)
  db.transaction(() => {
    for (let id = 1; id <= ROWS; id++) {
      const country = id % 5 === 0 ? 'DE' : 'US'
      const miles = ((id * 7919) % 4000) / 100
      // A few rated trails, with ties in rating and in reviews, as a young
      // catalog has; the rest unrated, where the length order takes over.
      const rated = id % 37 === 0
      const rating = rated ? 3 + (id % 5) * 0.5 : 0
      const reviews = rated ? 1 + (id % 7) : 0
      // Shared names, as the catalog has: many rows called "Ridge Trail".
      insert.run(id, `Trail ${(id * 31) % 900}`, miles, rating, reviews, 39 + (id % 100) / 100, -105 + (id % 77) / 100, `uuid-${id}`, `way/${id}`, country, country === 'US' ? 'CO' : 'DE-BY')
      if (id % 4 === 0)
        part.run(id, id - 1, country)
    }
  })()
  db.run('ANALYZE')
})

afterAll(() => db?.close())

function listed(order: Order, country?: string, offset = 0): { sql: string, params: unknown[] } {
  let query: any = (Trail as any).query().whereRaw(NOT_FOLDED_SQL)
  if (country)
    query = query.where('country', country)
  for (const [column, direction] of order)
    query = query.orderBy(column, direction)
  return query.limit(200).offset(offset).toSql()
}

const plan = ({ sql, params }: { sql: string, params: unknown[] }): string =>
  (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as any[])) as any[]).map(row => row.detail).join(' | ')

const ids = ({ sql, params }: { sql: string, params: unknown[] }, table = 'trails'): number[] =>
  (db.query(sql.replace('FROM trails', `FROM ${table}`)).all(...(params as any[])) as any[]).map(row => Number(row.id))

/** An index's key columns and their directions, with the rowid it ends on as id. */
function indexColumns(name: string): Array<[string, string]> {
  return (db.query(`PRAGMA index_xinfo(${name})`).all() as any[])
    .filter(row => row.key || row.cid === -1)
    .map(row => [row.cid === -1 ? 'id' : row.name, row.desc ? 'desc' : 'asc'])
}

describe.each(ORDERS)('the catalog sorted by $sort without a location', ({ order, everywhere, byCountry }) => {
  it('is ordered exactly as its indexes are, ending on the rowid', () => {
    const wanted = order.map(([column, direction]) => [column, direction])
    expect(indexColumns(everywhere)).toEqual(wanted)
    expect(indexColumns(byCountry)).toEqual([['country', 'asc'], ...wanted])
    // id last and ascending: the rowid every index entry already ends on.
    expect(order[order.length - 1]).toEqual(['id', 'asc'])
  })

  it('walks its index everywhere instead of sorting the catalog', () => {
    const detail = plan(listed(order))
    expect(detail).toContain(everywhere)
    expect(detail).not.toContain('TEMP B-TREE')
  })

  it('walks the one led by country for one country', () => {
    for (const country of ['US', 'DE']) {
      const detail = plan(listed(order, country))
      expect(detail, country).toContain(`${byCountry} (country=?)`)
      expect(detail, country).not.toContain('TEMP B-TREE')
    }
  })

  it('still walks it a few pages in', () => {
    expect(plan(listed(order, 'US', 2000))).not.toContain('TEMP B-TREE')
    expect(plan(listed(order, undefined, 2000))).not.toContain('TEMP B-TREE')
  })

  it('still leaves out the pieces of other trails', () => {
    expect(plan(listed(order, 'US'))).toContain('USING ROWID SEARCH ON TABLE trail_parts FOR IN-OPERATOR')
    const page = ids(listed(order, 'US'))
    expect(page).toHaveLength(200)
    expect(page.some(id => id % 4 === 0)).toBe(false)
  })

  it('returns the rows a full sort would, page after page', () => {
    for (const offset of [0, 200, 2000]) {
      for (const country of ['US', undefined]) {
        const query = listed(order, country, offset)
        expect(ids(query), `${country ?? 'everywhere'} @${offset}`).toEqual(ids(query, 'trails NOT INDEXED'))
      }
    }
  })
})

describe('top rated', () => {
  it('opens on the rated trails, best first, and falls back to the length order', () => {
    const rows = db.query(listed(RATING_ORDER, 'US').sql).all('US') as any[]
    const ratings = rows.map(row => Number(row.rating))
    expect(ratings[0]).toBeGreaterThan(0)
    expect(ratings).toEqual([...ratings].sort((a, b) => b - a))
  })
})

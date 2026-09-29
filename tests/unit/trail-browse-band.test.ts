import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'

/**
 * What the catalog opens on.
 *
 * The trails table is imported from OpenStreetMap, where a "way" is whatever a
 * mapper drew between two junctions, so most rows are not trails anybody would
 * set out to walk: a production slice is 57% under four tenths of a mile, with
 * a median length of 0.32 miles. The catalog used to answer that by opening on
 * the longest routes, which put four thousand-mile thru-hikes on the first
 * screen — the opposite extreme of the same mistake.
 *
 * `browse_band` is the fix, and it is a generated column in a migration rather
 * than code, so this runs the migration's own SQL against a real SQLite rather
 * than re-implementing the rule and testing the copy.
 */

const MIGRATION = 'database/migrations/0000000175-alter-trails-browse-band.sql'

/** A trails table with the one column the band is computed from, then the migration. */
async function catalog(): Promise<Database> {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE "trails" (
    "id" INTEGER PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "distance" REAL NOT NULL,
    "rating" REAL NOT NULL DEFAULT 0,
    "review_count" INTEGER NOT NULL DEFAULT 0,
    "national_trail" INTEGER NOT NULL DEFAULT 0
  )`)

  // Split on semicolons exactly as the migration runner does. This is also
  // what makes the file's "no semicolons in comments" rule load-bearing.
  const sql = await Bun.file(MIGRATION).text()
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean))
    db.run(statement)

  return db
}

function add(db: Database, name: string, distance: number, rating = 0): void {
  db.run('INSERT INTO trails (name, distance, rating) VALUES (?, ?, ?)', [name, distance, rating])
}

const bandOf = (db: Database, name: string): number =>
  (db.query('SELECT browse_band AS b FROM trails WHERE name = ?').get(name) as any).b

describe('browse_band', () => {
  it('puts a day hike in front', async () => {
    const db = await catalog()
    for (const [name, miles] of [['Angels Landing', 4.4], ['Half Dome', 14.2], ['Dipsea', 7.4]] as const)
      add(db, name, miles)

    for (const name of ['Angels Landing', 'Half Dome', 'Dipsea'])
      expect(bandOf(db, name), name).toBe(0)
  })

  /*
   * The two shapes this exists to demote, and they are opposite extremes.
   *
   * A quarter-mile way fragment is most of the catalog by row count. A
   * thousand-mile thru-hike is what sorting by length put on the front page
   * instead. Neither is what somebody browsing for a hike wants first.
   */
  it('sends fragments and thru-hikes to the back, together', async () => {
    const db = await catalog()
    add(db, 'unnamed OSM spur', 0.22)
    add(db, 'North Country National Scenic Trail', 1161.5)

    expect(bandOf(db, 'unnamed OSM spur')).toBe(2)
    expect(bandOf(db, 'North Country National Scenic Trail')).toBe(2)
  })

  it('keeps a short walk and a long expedition in the middle', async () => {
    const db = await catalog()
    add(db, 'lakeside loop', 0.6)
    add(db, 'three day traverse', 24)

    expect(bandOf(db, 'lakeside loop')).toBe(1)
    expect(bandOf(db, 'three day traverse')).toBe(1)
  })

  it('bands each boundary on the inclusive side', async () => {
    const db = await catalog()
    const edges: [string, number, number][] = [
      ['just under a walk', 0.39, 2],
      ['bottom of a walk', 0.4, 1],
      ['just under a hike', 0.99, 1],
      ['bottom of a hike', 1, 0],
      ['top of a hike', 15, 0],
      ['just over a hike', 15.01, 1],
      ['top of an expedition', 30, 1],
      ['just over an expedition', 30.01, 2],
    ]
    for (const [name, miles] of edges) add(db, name, miles)
    for (const [name, , band] of edges) expect(bandOf(db, name), `${name} @ ${band}`).toBe(band)
  })

  it('costs nothing to keep true, because nothing writes it', async () => {
    // Generated from distance, so an import that knows nothing about banding
    // still lands in the right one — and correcting a length re-bands the row
    // with no backfill.
    const db = await catalog()
    add(db, 'mismeasured', 400)
    expect(bandOf(db, 'mismeasured')).toBe(2)

    db.run('UPDATE trails SET distance = 6 WHERE name = ?', ['mismeasured'])
    expect(bandOf(db, 'mismeasured')).toBe(0)
  })
})

describe('the first screen of the catalog', () => {
  /** The default ordering from TrailIndexAction, in the order it applies them. */
  const FEATURED = `
    ORDER BY browse_band ASC, rating DESC, review_count DESC,
             national_trail DESC, distance DESC, id ASC
  `

  it('opens on day hikes, longest first, not on thru-hikes', async () => {
    const db = await catalog()
    // The four that production actually served, plus what should displace them.
    add(db, 'North Country NST (MI)', 1161.5)
    add(db, 'North Country NST (OH)', 1069.7)
    add(db, 'Grand Enchantment', 1036.5)
    add(db, 'unnamed spur', 0.3)
    add(db, 'Half Dome', 14.2)
    add(db, 'Alum Cave', 11)
    add(db, 'Angels Landing', 4.4)

    const names = (db.query(`SELECT name FROM trails ${FEATURED}`).all() as any[]).map(r => r.name)
    expect(names.slice(0, 3)).toEqual(['Half Dome', 'Alum Cave', 'Angels Landing'])
    // Not merely "further down" — behind every hikeable trail there is.
    expect(names.indexOf('North Country NST (MI)')).toBeGreaterThan(names.indexOf('Angels Landing'))
  })

  /*
   * Ratings rank above length on purpose, and rank nothing today: production
   * is 0% rated. The ordering is written so that the day the catalog gains
   * ratings they take over without another change to the query.
   */
  it('lets a rating outrank length as soon as one exists', async () => {
    const db = await catalog()
    add(db, 'long and unrated', 14)
    add(db, 'short and loved', 2, 4.8)

    const names = (db.query(`SELECT name FROM trails ${FEATURED}`).all() as any[]).map(r => r.name)
    expect(names[0]).toBe('short and loved')
  })

  it('still ranks by length while nothing is rated', async () => {
    const db = await catalog()
    add(db, 'six miles', 6)
    add(db, 'two miles', 2)
    add(db, 'ten miles', 10)

    const names = (db.query(`SELECT name FROM trails ${FEATURED}`).all() as any[]).map(r => r.name)
    expect(names).toEqual(['ten miles', 'six miles', 'two miles'])
  })

  it('orders two identical trails the same way twice', async () => {
    // Paging depends on it: without a stable last key, page two can repeat or
    // skip whatever the engine felt like putting 60th.
    const db = await catalog()
    add(db, 'twin a', 5)
    add(db, 'twin b', 5)

    const once = (db.query(`SELECT id FROM trails ${FEATURED}`).all() as any[]).map(r => r.id)
    const twice = (db.query(`SELECT id FROM trails ${FEATURED}`).all() as any[]).map(r => r.id)
    expect(once).toEqual(twice)
    expect(once).toEqual([...once].sort((a, b) => a - b))
  })
})

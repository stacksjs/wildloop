import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  buildSuggestions,
  MAX_PLACES,
  MAX_TRAILS,
  placeSuggestionsSql,
  REBUILD_SEARCH_PLACES_SQL,
  suggestMatch,
  trailSuggestionsSql,
} from '../../app/Support/searchSuggest'

describe('suggestMatch', () => {
  it('waits for two characters, since one matches most of the catalog', () => {
    expect(suggestMatch('')).toBeNull()
    expect(suggestMatch('e')).toBeNull()
    expect(suggestMatch('  -  ')).toBeNull()
    expect(suggestMatch('es')).toBe('"es"*')
  })

  it('quotes each word and treats only the last as a prefix, because it is still being typed', () => {
    expect(suggestMatch('Estes Pa')).toBe('"estes" "pa"*')
  })

  it('reduces FTS syntax to plain words rather than passing it through', () => {
    // Every one of these is query syntax to FTS5; left in, they either break
    // the query or change what it means.
    expect(suggestMatch('mont-blanc: "tour" OR *')).toBe('"mont" "blanc" "tour" "or"*')
    expect(suggestMatch('x\' OR 1=1 --')).toBe('"x" "or" "1" "1"*')
  })

  it('keeps letters outside ASCII, which the tokenizer folds itself', () => {
    expect(suggestMatch('Höllental')).toBe('"höllental"*')
  })

  it('keeps a decomposed accent inside its word instead of splitting on it', () => {
    // "Zürich" as "u" plus U+0308, the form some paste sources produce.
    expect(suggestMatch('Zu\u0308rich')).toBe('"zürich"*')
    expect(suggestMatch('Zu\u0308rich')).toBe(suggestMatch('Zürich'))
  })

  it('restricts to a column when asked', () => {
    expect(suggestMatch('lost lak', 'name')).toBe('name : ("lost" "lak"*)')
  })
})

describe('buildSuggestions', () => {
  it('sends a region to its filter, a place to a search for it, and a trail to its page', () => {
    const out = buildSuggestions(
      [
        { kind: 'region', label: 'Bayern', state: 'DE-BY', country: 'DE', trail_count: 1200 },
        { kind: 'place', label: 'Estes Park, CO', state: 'CO', country: 'US', trail_count: 1 },
      ],
      [{ id: 12, name: 'Angels Landing', location: 'Springdale, UT' }],
    )

    expect(out).toEqual([
      { kind: 'region', label: 'Bayern', detail: 'Region · 1,200 trails', href: '/trails?state=DE-BY&country=DE' },
      { kind: 'place', label: 'Estes Park, CO', detail: '1 trail', href: '/trails?q=Estes%20Park%2C%20CO' },
      { kind: 'trail', label: 'Angels Landing', detail: 'Springdale, UT', href: '/trail/12' },
    ])
  })

  it('encodes spaces as %20, the form /trails is known to read back', () => {
    const [place] = buildSuggestions([{ kind: 'place', label: 'Yosemite Valley, CA', state: 'CA', country: 'US', trail_count: 2 }], [])
    expect(place.href).toBe('/trails?q=Yosemite%20Valley%2C%20CA')
    expect(place.href).not.toContain('+')
  })

  it('collapses one trail recorded twice in a state, but keeps same-named trails elsewhere', () => {
    const out = buildSuggestions([], [
      { id: 1, name: 'Lower Yosemite Fall Trail', location: 'Yosemite National Park, CA', state: 'CA' },
      { id: 2, name: 'Lower Yosemite Fall Trail', location: 'California', state: 'CA' },
      { id: 3, name: 'lower yosemite fall trail ', location: 'California', state: 'ca' },
      { id: 4, name: 'Lost Lake Trail', location: 'Oregon', state: 'OR' },
      { id: 5, name: 'Lost Lake Trail', location: 'Colorado', state: 'CO' },
    ])
    expect(out.map(s => s.href)).toEqual(['/trail/1', '/trail/4', '/trail/5'])
  })

  it('still offers a full set of trails after collapsing duplicates', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, name: `Trail ${Math.floor(i / 2)}`, location: 'X', state: 'CA' }))
    expect(buildSuggestions([], rows).filter(s => s.kind === 'trail')).toHaveLength(MAX_TRAILS)
  })

  it('skips a region with no code to filter by', () => {
    expect(buildSuggestions([{ kind: 'region', label: 'Nowhere', state: '', country: 'US', trail_count: 3 }], [])).toEqual([])
  })
})

let database: Database | null = null

afterEach(() => {
  database?.close()
  database = null
})

/** Split the way the migration runner does: on semicolons, comment lines dropped. */
async function applyMigration(db: Database, file: string): Promise<void> {
  const text = await Bun.file(file).text()
  for (const statement of text.split(';')) {
    const sql = statement.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').trim()
    if (sql)
      db.run(sql)
  }
}

async function catalog(): Promise<Database> {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE trails (
    id INTEGER PRIMARY KEY, name TEXT, location TEXT, state TEXT, state_name TEXT,
    country TEXT, rating REAL, review_count INTEGER
  )`)
  // The production trail index, read from its migration so the two cannot drift.
  const fts = (await Bun.file('database/migrations/0000000079-create-trails-fts.sql').text())
    .match(/CREATE VIRTUAL TABLE IF NOT EXISTS trails_fts[\s\S]*?\)/)?.[0]
  expect(fts).toBeTruthy()
  db.run(fts!)
  await applyMigration(db, 'database/migrations/0000000156-create-search-places.sql')

  const insert = db.prepare('INSERT INTO trails (id, name, location, state, state_name, country, rating, review_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  const rows: [number, string, string, string, string, string, number, number][] = [
    [1, 'Emerald Lake Trail', 'Estes Park, CO', 'CO', 'Colorado', 'US', 4.8, 900],
    [2, 'Sky Pond via Glacier Gorge', 'Estes Park, CO', 'CO', 'Colorado', 'US', 4.9, 400],
    [3, 'Maroon Lake Scenic Trail', 'Aspen, CO', 'CO', 'Colorado', 'US', 4.7, 1200],
    // How OSM records a trail: the region and nothing finer.
    [4, 'Lost Lake Loop', 'Colorado', 'CO', 'Colorado', 'US', 4.1, 10],
    [5, 'Höllentalklamm', 'Grainau, Bayern', 'DE-BY', 'Bayern', 'DE', 4.9, 50],
    [6, 'Feldberg Rundweg', 'Feldberg, Baden-Württemberg', 'DE-BW', 'Baden-Württemberg', 'DE', 4.5, 30],
    [7, 'Jenny Lake Loop', 'Moose, WY', 'WY', 'Wyoming', 'US', 4.6, 700],
    [8, 'Unnamed Path', '', 'CO', 'Colorado', 'US', 3.0, 0],
    // One trail recorded by two sources: the agency copy and a region-only one.
    [9, 'Lower Yosemite Fall Trail', 'California', 'CA', 'California', 'US', 0, 0],
    [10, 'Lower Yosemite Fall Trail', 'Yosemite National Park, CA', 'CA', 'California', 'US', 0, 0],
  ]
  for (const row of rows)
    insert.run(...row)
  db.run(`INSERT INTO trails_fts(trails_fts) VALUES ('rebuild')`)

  for (const statement of REBUILD_SEARCH_PLACES_SQL)
    db.run(statement)
  return db
}

describe('search places, built from the trails', () => {
  it('has a place per recorded location and a region per state, with trail counts', async () => {
    database = await catalog()
    const rows = database.query('SELECT kind, label, state, country, trail_count FROM search_places ORDER BY kind, label').all()

    expect(rows).toEqual([
      { kind: 'place', label: 'Aspen, CO', state: 'CO', country: 'US', trail_count: 1 },
      { kind: 'place', label: 'Estes Park, CO', state: 'CO', country: 'US', trail_count: 2 },
      { kind: 'place', label: 'Feldberg, Baden-Württemberg', state: 'DE-BW', country: 'DE', trail_count: 1 },
      { kind: 'place', label: 'Grainau, Bayern', state: 'DE-BY', country: 'DE', trail_count: 1 },
      { kind: 'place', label: 'Moose, WY', state: 'WY', country: 'US', trail_count: 1 },
      { kind: 'place', label: 'Yosemite National Park, CA', state: 'CA', country: 'US', trail_count: 1 },
      { kind: 'region', label: 'Baden-Württemberg', state: 'DE-BW', country: 'DE', trail_count: 1 },
      { kind: 'region', label: 'Bayern', state: 'DE-BY', country: 'DE', trail_count: 1 },
      { kind: 'region', label: 'California', state: 'CA', country: 'US', trail_count: 2 },
      { kind: 'region', label: 'Colorado', state: 'CO', country: 'US', trail_count: 5 },
      { kind: 'region', label: 'Wyoming', state: 'WY', country: 'US', trail_count: 1 },
    ])
  })

  it('does not list a region-only location as a place of its own', async () => {
    database = await catalog()
    const colorado = database.query(`SELECT kind FROM search_places WHERE label = 'Colorado'`).all()
    expect(colorado).toEqual([{ kind: 'region' }])
  })

  it('rebuilds to the same list rather than accumulating duplicates', async () => {
    database = await catalog()
    const before = database.query('SELECT count(*) AS n FROM search_places').get() as { n: number }
    for (const statement of REBUILD_SEARCH_PLACES_SQL)
      database.run(statement)
    expect(database.query('SELECT count(*) AS n FROM search_places').get()).toEqual(before)
  })
})

describe('suggestion queries', () => {
  const places = (db: Database, text: string) => db.query(placeSuggestionsSql(suggestMatch(text)!)).all() as any[]
  const trails = (db: Database, text: string) => db.query(trailSuggestionsSql(suggestMatch(text, 'name')!)).all() as any[]

  it('finds a town from its first letters', async () => {
    database = await catalog()
    expect(places(database, 'est').map(p => p.label)).toEqual(['Estes Park, CO'])
  })

  it('puts the place with the most trails first', async () => {
    database = await catalog()
    expect(places(database, 'col').map(p => p.label)).toEqual(['Colorado', 'Estes Park, CO', 'Aspen, CO'])
  })

  it('matches without the diacritics a visitor may not type', async () => {
    database = await catalog()
    expect(places(database, 'baden wurt').map(p => p.label)).toContain('Baden-Württemberg')
  })

  it('finds a trail typed with a decomposed accent', async () => {
    database = await catalog()
    expect(trails(database, 'Ho\u0308llen').map(t => t.name)).toEqual(['Höllentalklamm'])
  })

  it('suggests trails by name only, most reviewed first', async () => {
    database = await catalog()
    expect(trails(database, 'lak').map(t => t.name)).toEqual([
      'Maroon Lake Scenic Trail',
      'Emerald Lake Trail',
      'Jenny Lake Loop',
      'Lost Lake Loop',
    ])
    // "estes" is where these trails are, not what they are called. The place
    // suggestion covers it.
    expect(trails(database, 'estes')).toEqual([])
  })

  it('offers a trail recorded twice once, under its more specific location', async () => {
    database = await catalog()
    const out = buildSuggestions([], trails(database, 'lower yos'))
    expect(out).toEqual([
      { kind: 'trail', label: 'Lower Yosemite Fall Trail', detail: 'Yosemite National Park, CA', href: '/trail/10' },
    ])
  })

  it('caps each group', async () => {
    database = await catalog()
    expect(places(database, 'co').length).toBeLessThanOrEqual(MAX_PLACES)
    expect(trails(database, 'tr').length).toBeLessThanOrEqual(MAX_TRAILS)
  })

  it('runs hostile input as plain words and finds nothing, rather than failing', async () => {
    database = await catalog()
    expect(places(database, '\' OR 1=1; DROP TABLE trails; --')).toEqual([])
    expect(database.query('SELECT count(*) AS n FROM trails').get()).toEqual({ n: 10 })
  })
})

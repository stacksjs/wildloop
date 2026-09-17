import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import { dogPolicy } from '../../app/Ingest/sources/osm'
import { trailNotices } from '../../resources/functions/trail-features'

describe('dogPolicy', () => {
  it('reads an explicit OSM dog tag', () => {
    expect(dogPolicy('yes')).toBe(true)
    expect(dogPolicy('leashed')).toBe(true)
    expect(dogPolicy('designated')).toBe(true)
    expect(dogPolicy('no')).toBe(false)
  })

  it('treats a missing or unfamiliar tag as not recorded, not as no', () => {
    // Most ways carry no dog tag. Reading that as "no" put a "No dogs"
    // notice on nearly every OSM trail.
    expect(dogPolicy(undefined)).toBeNull()
    expect(dogPolicy('')).toBeNull()
    expect(dogPolicy('unknown')).toBeNull()
  })
})

describe('trail notices for dog policy', () => {
  it('warns about dogs only when the catalog says no', () => {
    expect(trailNotices({ dogsAllowed: false } as any).map(n => n.key)).toContain('no-dogs')
    expect(trailNotices({ dogsAllowed: null } as any).map(n => n.key)).not.toContain('no-dogs')
    expect(trailNotices({ dogsAllowed: true } as any).map(n => n.key)).not.toContain('no-dogs')
  })
})

let database: Database | null = null

afterEach(() => {
  database?.close()
  database = null
})

describe('clearing guessed dog policies', () => {
  it('clears what the ingest guessed and keeps what a source or a person recorded', async () => {
    database = new Database(':memory:')
    database.run('CREATE TABLE trails (id INTEGER PRIMARY KEY, source TEXT, source_id TEXT, dogs_allowed INTEGER)')
    const insert = database.prepare('INSERT INTO trails (id, source, source_id, dogs_allowed) VALUES (?, ?, ?, ?)')
    const rows: [number, string, string, number | null][] = [
      [1, 'nps', 'nps/ZION|ANGELS LANDING', 0], // hardcoded no
      [2, 'usfs', 'usfs/060505|1194|SKOOKUM FLATS', 1], // hardcoded yes
      [3, 'osm', 'relation/2281020', 0], // missing tag read as no
      [4, 'osm', 'way/9001', 1], // explicit dog=yes
      [5, 'nps', 'acad-precipice', 0], // seeded, hand-checked
      [6, 'usfs', 'maroon-lake', 1], // seeded, hand-checked
      [7, 'osm', 'mill-valley-dipsea', 0], // seeded, hand-checked
      [8, 'osm', 'relation/77', null], // already unknown
    ]
    for (const row of rows)
      insert.run(...row)

    // Split the way the migration runner does: on semicolons, comment lines dropped.
    const text = await Bun.file('database/migrations/0000000157-clear-guessed-trail-dog-policy.sql').text()
    for (const statement of text.split(';')) {
      const sql = statement.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').trim()
      if (sql)
        database.run(sql)
    }

    const after = Object.fromEntries(
      (database.query('SELECT id, dogs_allowed FROM trails ORDER BY id').all() as { id: number, dogs_allowed: number | null }[])
        .map(r => [r.id, r.dogs_allowed]),
    )
    expect(after).toEqual({ 1: null, 2: null, 3: null, 4: 1, 5: 0, 6: 1, 7: 0, 8: null })
  })
})

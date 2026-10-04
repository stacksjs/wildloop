import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'

/**
 * An in-memory SQLite holding the trail catalog exactly as the migrations
 * build it: the trails table with every column added since, its indexes, the
 * search index, community photos, and `trail_parts`. Every migration whose
 * name mentions a trail is applied in order, so a new one is picked up
 * without this file changing, plus the users and activities tables they refer to.
 */

const MIGRATIONS = resolve(import.meta.dir, '../../database/migrations')

const EXTRA = new Set(['0000000008-create-activities-table.sql', '0000000016-create-users-table.sql'])

export const TRAIL_MIGRATIONS = readdirSync(MIGRATIONS)
  .filter(file => file.endsWith('.sql') && (/trail/.test(file) || EXTRA.has(file)))
  .sort()

/** Applies one migration file the way the runner does: statement by statement. */
function migrate(db: Database, file: string): void {
  const text = readFileSync(resolve(MIGRATIONS, file), 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('--'))
    .join('\n')
  for (const statement of text.split(';')) {
    if (statement.trim())
      db.run(statement)
  }
}

/** The catalog schema, empty. */
export function trailCatalogDatabase(): Database {
  const db = new Database(':memory:')
  for (const file of TRAIL_MIGRATIONS)
    migrate(db, file)
  return db
}

export interface TrailFixture {
  id: number
  name: string
  /** `[lat, lng]` points. The row starts at the first. */
  line: Array<[number, number]>
  country?: string
  source?: string
  distance?: number
  reviewCount?: number
}

export function insertTrails(db: Database, trails: TrailFixture[]): void {
  const insert = db.prepare(`INSERT INTO trails
    (id, name, location, distance, elevation, difficulty, rating, review_count, latitude, longitude, geometry, uuid, source, source_id, country, state, state_name)
    VALUES (?, ?, 'Somewhere', ?, 0, 'easy', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (const t of trails) {
    const country = t.country ?? 'US'
    insert.run(
      t.id, t.name, t.distance ?? 1, t.reviewCount ?? 0, t.line[0][0], t.line[0][1], JSON.stringify(t.line), `uuid-${t.id}`,
      t.source ?? 'osm', `way/${t.id}`, country, country === 'US' ? 'CO' : 'DE-BY', country === 'US' ? 'Colorado' : 'Bayern',
    )
  }
  db.run(`INSERT INTO trails_fts(trails_fts) VALUES ('rebuild')`)
}

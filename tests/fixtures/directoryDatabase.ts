import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'

/**
 * An in-memory SQLite with the tables behind the athlete directory, the
 * activity leaderboard and the events directory, built from the app's own
 * migrations so the CHECKs and the indexes the queries rely on are the real
 * ones. The same idea as `clubDatabase`, for `app/Support/athleteSearch`,
 * `activityLeaderboard` and `eventDirectory`.
 */

const MIGRATIONS = resolve(import.meta.dir, '../../database/migrations')
const SCHEMA = [
  '0000000016-create-users-table.sql',
  '0000000167-alter-users-profile-columns.sql',
  '0000000008-create-activities-table.sql',
  '0000000134-create-activities_user_completed_index-index-in-activities.sql',
  '0000000184-create-activities_odd_completed_index-index-in-activities.sql',
  '0000000013-create-follows-table.sql',
  '0000000035-create-follows_follower_following_unique-index-in-follows.sql',
  '0000000017-create-territory_stats-table.sql',
  '0000000041-create-territory_stats_user_unique-index-in-territory_stats.sql',
  '0000000087-create-user_blocks-table.sql',
  '0000000007-create-trails-table.sql',
  '0000000012-create-clubs-table.sql',
  '0000000018-create-club_members-table.sql',
  '0000000043-create-club_members_club_user_unique-index-in-club_members.sql',
  '0000000116-create-events-table.sql',
  '0000000160-alter-events-columns.sql',
  '0000000117-create-event_entrants-table.sql',
]

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

/** The schema, empty, plus any migrations a test adds on top. */
export function directoryDatabase(extra: string[] = []): Database {
  const db = new Database(':memory:')
  for (const file of [...SCHEMA, ...extra])
    migrate(db, file)
  return db
}

/** A track on every activity, as in production: none of the queries may need it. */
export const TRACK = JSON.stringify({ type: 'LineString', coordinates: Array.from({ length: 50 }, (_, i) => [-105 + i / 1000, 40 + i / 1000]) })

export interface UserFixture {
  id: number
  name: string | null
  avatar?: string | null
  location?: string | null
}

export function insertUsers(db: Database, users: UserFixture[]): void {
  const insert = db.prepare('INSERT INTO users (id, name, email, avatar, location) VALUES (?, ?, ?, ?, ?)')
  for (const u of users)
    insert.run(u.id, u.name, `user-${u.id}@example.test`, u.avatar ?? null, u.location ?? null)
}

export function insertFollows(db: Database, follows: Array<[follower: number, following: number]>): void {
  const insert = db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)')
  for (const [follower, following] of follows)
    insert.run(follower, following)
}

export function insertBlocks(db: Database, blocks: Array<[blocker: number, blocked: number]>): void {
  const insert = db.prepare('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)')
  for (const [blocker, blocked] of blocks)
    insert.run(blocker, blocked)
}

/** Both sides of a block, as `blockedUserIdsFor` reads them. */
export function blockedFor(db: Database, viewer: number | null): Set<number> {
  if (!viewer)
    return new Set()
  const rows = db.query('SELECT blocker_id, blocked_id FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?').all(viewer, viewer) as any[]
  return new Set(rows.map(row => row.blocker_id === viewer ? row.blocked_id : row.blocker_id))
}

export interface ActivityRowFixture {
  user_id: number | null
  visibility: 'public' | 'followers' | 'private' | null
  distance: number | null
  elevation?: number | null
  completed_at: string | null
  /** Left to the column default (`CURRENT_TIMESTAMP`) when absent. */
  created_at?: string
}

export function insertActivities(db: Database, activities: ActivityRowFixture[]): void {
  const insert = db.prepare('INSERT INTO activities (user_id, activity_type, distance, elevation, visibility, completed_at, gpx_data) VALUES (?, ?, ?, ?, ?, ?, ?)')
  const stamped = db.prepare('INSERT INTO activities (user_id, activity_type, distance, elevation, visibility, completed_at, gpx_data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
  for (const a of activities) {
    if (a.created_at === undefined)
      insert.run(a.user_id, 'Trail Run', a.distance, a.elevation ?? null, a.visibility, a.completed_at, TRACK)
    else
      stamped.run(a.user_id, 'Trail Run', a.distance, a.elevation ?? null, a.visibility, a.completed_at, TRACK, a.created_at)
  }
}

/** The plan SQLite would use, one line per step. */
export function planOf(db: Database, sql: string, params: unknown[] = []): string {
  return (db.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as any[])) as Array<{ detail: string }>)
    .map(row => row.detail)
    .join('\n')
}

/** Runs SQL the way the actions' `db.unsafe` runner does. */
export function runner(db: Database): (sql: string, params?: unknown[]) => Promise<any[]> {
  return async (sql, params = []) => db.query(sql).all(...(params as any[])) as any[]
}

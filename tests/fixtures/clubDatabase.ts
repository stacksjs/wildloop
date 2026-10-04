import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'

/**
 * An in-memory SQLite with the clubs tables, built from the app's own
 * migrations so the CHECK on visibility and the indexes the queries rely on
 * are the real ones. For the club SQL in `app/Support/clubWeeklyStats`
 * and `app/Support/clubRecentFeed`.
 */

const MIGRATIONS = resolve(import.meta.dir, '../../database/migrations')
const SCHEMA = [
  '0000000008-create-activities-table.sql',
  '0000000013-create-follows-table.sql',
  '0000000018-create-club_members-table.sql',
  '0000000134-create-activities_user_completed_index-index-in-activities.sql',
  '0000000184-create-activities_odd_completed_index-index-in-activities.sql',
  '0000000043-create-club_members_club_user_unique-index-in-club_members.sql',
  '0000000035-create-follows_follower_following_unique-index-in-follows.sql',
]

export const DAY = 24 * 60 * 60 * 1000

export interface ActivityFixture {
  user_id: number
  visibility: 'public' | 'followers' | 'private' | null
  distance: number | null
  completed_at: string | null
  /** Left to the column default (`CURRENT_TIMESTAMP`) when absent. */
  created_at?: string
}

export function clubDatabase(
  memberships: Array<[club: number, user: number]>,
  follows: Array<[follower: number, following: number]>,
  activities: ActivityFixture[],
): Database {
  const db = new Database(':memory:')
  for (const file of SCHEMA)
    db.run(readFileSync(resolve(MIGRATIONS, file), 'utf8'))

  const member = db.prepare('INSERT INTO club_members (club_id, user_id, role) VALUES (?, ?, ?)')
  for (const [club, user] of memberships)
    member.run(club, user, 'member')
  const follow = db.prepare('INSERT INTO follows (follower_id, following_id) VALUES (?, ?)')
  for (const [follower, following] of follows)
    follow.run(follower, following)
  // A track on every row, as in production: the club SQL must not need it.
  const track = '{"type":"LineString","coordinates":[]}'
  const activity = db.prepare('INSERT INTO activities (user_id, activity_type, distance, visibility, completed_at, gpx_data) VALUES (?, ?, ?, ?, ?, ?)')
  const stamped = db.prepare('INSERT INTO activities (user_id, activity_type, distance, visibility, completed_at, gpx_data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
  for (const a of activities) {
    if (a.created_at === undefined)
      activity.run(a.user_id, 'Trail Run', a.distance, a.visibility, a.completed_at, track)
    else
      stamped.run(a.user_id, 'Trail Run', a.distance, a.visibility, a.completed_at, track, a.created_at)
  }
  return db
}

/** The same instant written with a UTC offset, as a hand-made API call might. */
export function withOffset(ms: number, minutes: number): string {
  const local = new Date(ms + minutes * 60_000).toISOString().slice(0, 23)
  const abs = Math.abs(minutes)
  return `${local}${minutes < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/** Deterministic, so a failure reproduces. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/**
 * Every shape `completed_at` can arrive in that `Date.parse` reads:
 * canonical (weighted, as it is in practice), offset, no milliseconds, date
 * only, RFC 2822 and local time with no zone.
 */
export const READABLE_STAMPS: Array<(ms: number) => string> = [
  ms => new Date(ms).toISOString(),
  ms => new Date(ms).toISOString(),
  ms => new Date(ms).toISOString(),
  ms => withOffset(ms, 330),
  ms => withOffset(ms, -480),
  ms => `${new Date(ms).toISOString().slice(0, 19)}Z`,
  ms => new Date(ms).toISOString().slice(0, 10),
  ms => new Date(ms).toUTCString(),
  ms => new Date(ms).toISOString().slice(0, 19),
]

/** And the ones it doesn't: an impossible date, unreadable, empty, missing. */
export const UNREADABLE_STAMPS: Array<(ms: number) => string | null> = [
  ms => `${new Date(ms).toISOString().slice(0, 8)}31T00:00:00.000Z`,
  () => 'last tuesday',
  () => '',
  () => null,
]

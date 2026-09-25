import { afterEach, describe, expect, it } from 'bun:test'
import { Database } from 'bun:sqlite'
import {
  buildReviewerSummaries,
  MAX_FACES,
  MAX_TRAIL_IDS,
  readTrailIds,
  recentCutoff,
  recentReviewersSql,
  type ReviewerRow,
} from '../../app/Support/trailReviewers'

describe('reading the requested ids', () => {
  it('takes a comma list of positive integers, once each', () => {
    expect(readTrailIds('3,1,3,2')).toEqual([3, 1, 2])
  })

  it('drops everything that is not one', () => {
    expect(readTrailIds('1, -2, 0, 3.5, abc, 1e9999, ')).toEqual([1])
    expect(readTrailIds('')).toEqual([])
    expect(readTrailIds(null)).toEqual([])
  })

  it('stops at a page of results', () => {
    const ids = Array.from({ length: 200 }, (_, i) => i + 1).join(',')
    expect(readTrailIds(ids)).toHaveLength(MAX_TRAIL_IDS)
  })

  it('leaves nothing in the id list that could carry SQL', () => {
    expect(readTrailIds("1, 2); DROP TABLE trail_reviews; --")).toEqual([1])
    expect(recentReviewersSql(readTrailIds("1, 2); DROP TABLE trail_reviews; --"), recentCutoff())).not.toContain('DROP')
  })
})

describe('grouping the rows', () => {
  const row = (trail: number, user: number, name: string | null, count: number): ReviewerRow =>
    ({ trail_id: trail, user_id: user, name, recent_count: count })

  it('keeps the query order and the full window count', () => {
    const summaries = buildReviewerSummaries([
      row(1, 7, 'Ada', 31),
      row(1, 8, 'Grace', 31),
      row(2, 9, 'Alan', 2),
    ])

    expect(summaries[1]).toEqual({ recentCount: 31, reviewers: [{ id: 7, name: 'Ada', avatar: null }, { id: 8, name: 'Grace', avatar: null }] })
    expect(summaries[2]).toEqual({ recentCount: 2, reviewers: [{ id: 9, name: 'Alan', avatar: null }] })
  })

  it('counts a review whose author is gone without inventing a face for it', () => {
    const summaries = buildReviewerSummaries([row(1, 7, null, 4), row(1, 8, 'Grace', 4)])

    expect(summaries[1].recentCount).toBe(4)
    expect(summaries[1].reviewers).toEqual([{ id: 8, name: 'Grace', avatar: null }])
  })

  it('carries a photo when the reviewer has one, and only a safe one', () => {
    const photo = '/api/avatars/7/3f2b8c1e-9a4d-4e7f-b1c2-5d6e7f8a9b0c.jpg'
    const summaries = buildReviewerSummaries([
      { ...row(1, 7, 'Ada', 2), avatar: photo },
      { ...row(1, 8, 'Grace', 2), avatar: 'javascript:alert(1)' },
    ])

    expect(summaries[1].reviewers).toEqual([{ id: 7, name: 'Ada', avatar: photo }, { id: 8, name: 'Grace', avatar: null }])
  })
})

let database: Database | null = null

afterEach(() => {
  database?.close()
  database = null
})

function reviewsDatabase(): Database {
  const db = new Database(':memory:')
  db.run(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, avatar TEXT)`)
  db.run(`CREATE TABLE trail_reviews (
    id INTEGER PRIMARY KEY, user_id INTEGER, trail_id INTEGER, rating INTEGER, created_at TEXT
  )`)
  return db
}

function iso(daysAgo: number): string {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString()
}

describe('the query itself, against SQLite', () => {
  it('returns the newest faces and the whole window count', () => {
    database = reviewsDatabase()
    const users = database.prepare('INSERT INTO users (id, name) VALUES (?, ?)')
    for (const [id, name] of [[1, 'Ada'], [2, 'Grace'], [3, 'Alan'], [4, 'Edsger'], [5, 'Barbara']] as const)
      users.run(id, name)

    const reviews = database.prepare('INSERT INTO trail_reviews (id, user_id, trail_id, rating, created_at) VALUES (?, ?, ?, ?, ?)')
    // Five recent reviews on trail 1, newest first by user id 5 → 1.
    reviews.run(1, 5, 1, 5, iso(1))
    reviews.run(2, 4, 1, 4, iso(2))
    reviews.run(3, 3, 1, 5, iso(3))
    reviews.run(4, 2, 1, 4, iso(4))
    reviews.run(5, 1, 1, 5, iso(5))
    // Outside the window, so neither a face nor part of the count.
    reviews.run(6, 1, 1, 3, iso(120))
    // A different trail, and one with nothing recent at all.
    reviews.run(7, 2, 2, 5, iso(6))

    const rows = database.query(recentReviewersSql([1, 2, 3], recentCutoff())).all() as ReviewerRow[]
    const summaries = buildReviewerSummaries(rows)

    expect(summaries[1].recentCount).toBe(5)
    expect(summaries[1].reviewers.map(r => r.name)).toEqual(['Barbara', 'Edsger', 'Alan'])
    expect(summaries[1].reviewers).toHaveLength(MAX_FACES)
    expect(summaries[2]).toEqual({ recentCount: 1, reviewers: [{ id: 2, name: 'Grace', avatar: null }] })
    expect(summaries[3]).toBeUndefined()
  })

  it('keeps a review whose author was deleted in the count', () => {
    database = reviewsDatabase()
    database.run(`INSERT INTO users (id, name) VALUES (1, 'Ada')`)
    const reviews = database.prepare('INSERT INTO trail_reviews (id, user_id, trail_id, rating, created_at) VALUES (?, ?, ?, ?, ?)')
    reviews.run(1, 99, 1, 5, iso(1))
    reviews.run(2, 1, 1, 4, iso(2))

    const summaries = buildReviewerSummaries(database.query(recentReviewersSql([1], recentCutoff())).all() as ReviewerRow[])

    expect(summaries[1].recentCount).toBe(2)
    expect(summaries[1].reviewers).toEqual([{ id: 1, name: 'Ada', avatar: null }])
  })
})

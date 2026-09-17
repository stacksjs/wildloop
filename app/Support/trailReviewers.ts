/**
 * Who has reviewed a trail lately, for the cards on the catalog page.
 *
 * A list row shows a rating and a count, which says how a trail has been rated
 * over its whole life and nothing about whether anyone has walked it this
 * month. The faces answer that: three people who reported recently, and how
 * many reports there were.
 *
 * Deliberately its own endpoint rather than a join in `GET /api/trails`. That
 * query already counts its matches and returns geometry for every row; adding
 * a second table to it would slow the page down for a decoration that can
 * arrive a moment later, and it is the same reason `search/suggest` is
 * separate. The SQL lives here as plain strings so the tests run exactly what
 * the action runs.
 */

/** How recent "recent" is. A month is one season of conditions. */
export const RECENT_WINDOW_DAYS = 30

/** Faces per trail. Past three the stack stops being readable at card size. */
export const MAX_FACES = 3

/** The most trails one request may ask about — a page of results. */
export const MAX_TRAIL_IDS = 60

export interface ReviewerRow {
  trail_id: number
  user_id: number | null
  name: string | null
  recent_count: number
}

export interface Reviewer {
  id: number
  name: string
}

export interface ReviewerSummary {
  /** Reviews filed on this trail inside the window. */
  recentCount: number
  /** The most recent reviewers, newest first, at most `MAX_FACES`. */
  reviewers: Reviewer[]
}

/**
 * Sanitise the requested ids.
 *
 * Every id is reduced to a positive integer, which is what makes it safe to
 * inline them into the SQL below — the same reasoning as `suggestMatch`, where
 * the output alphabet is narrow enough that no input can escape it.
 */
export function readTrailIds(raw: string | null | undefined): number[] {
  if (!raw)
    return []

  const ids: number[] = []
  const seen = new Set<number>()

  for (const part of String(raw).split(',')) {
    const id = Number(part.trim())
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id))
      continue
    seen.add(id)
    ids.push(id)
    if (ids.length >= MAX_TRAIL_IDS)
      break
  }

  return ids
}

/** The cutoff timestamp for the window, as the column stores it. */
export function recentCutoff(now: Date = new Date(), days: number = RECENT_WINDOW_DAYS): string {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Recent reviewers and recent counts, in one pass.
 *
 * A window function does both jobs over the same scan: `ROW_NUMBER` picks the
 * newest few per trail, and `COUNT(*) OVER` reports the full total for the
 * window rather than the three rows that survive the cut. Two queries would
 * have had to agree with each other about what "recent" means.
 *
 * The join to users is a LEFT JOIN: a deleted account still filed the review,
 * and dropping the row would make the count disagree with the faces.
 */
export function recentReviewersSql(ids: number[], since: string): string {
  // `since` is generated above, never user input, and is quoted anyway.
  const cutoff = since.replace(/'/g, '')
  return `
    SELECT trail_id, user_id, name, recent_count
    FROM (
      SELECT
        r.trail_id AS trail_id,
        r.user_id AS user_id,
        u.name AS name,
        COUNT(*) OVER (PARTITION BY r.trail_id) AS recent_count,
        ROW_NUMBER() OVER (PARTITION BY r.trail_id ORDER BY r.created_at DESC, r.id DESC) AS rn
      FROM trail_reviews r
      LEFT JOIN users u ON u.id = r.user_id
      WHERE r.trail_id IN (${ids.join(', ')})
        AND r.created_at >= '${cutoff}'
    )
    WHERE rn <= ${MAX_FACES}
    ORDER BY trail_id, rn
  `.trim()
}

/**
 * Group the rows by trail, keeping the order the query returned them in.
 *
 * A reviewer with no name left is skipped rather than shown as "Unknown": an
 * anonymous face on a card is noise, while the count it belongs to is still
 * true and stays.
 */
export function buildReviewerSummaries(rows: ReviewerRow[]): Record<number, ReviewerSummary> {
  const summaries: Record<number, ReviewerSummary> = {}

  for (const row of rows ?? []) {
    const trailId = Number(row.trail_id)
    if (!Number.isFinite(trailId))
      continue

    const summary = summaries[trailId] ?? { recentCount: Number(row.recent_count) || 0, reviewers: [] }
    const name = String(row.name ?? '').trim()
    const userId = Number(row.user_id)

    if (name && Number.isFinite(userId) && summary.reviewers.length < MAX_FACES)
      summary.reviewers.push({ id: userId, name })

    summaries[trailId] = summary
  }

  return summaries
}

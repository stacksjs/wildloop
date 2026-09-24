/**
 * A trail's reviews, and so its condition reports, kept for 15 minutes.
 *
 * Every trail page asks for them on every view, and they change only when
 * someone reviews that trail. Held in this API process, keyed by trail and
 * page, and dropped the moment a review for that trail is written or an
 * account and its reviews are deleted, so the 15 minutes only ever applies
 * to reads, never to a change somebody just made.
 *
 * Bounded: past MAX_ENTRIES the oldest entry goes, so a crawl of the whole
 * catalog cannot grow it without limit.
 */

export const REVIEW_CACHE_TTL_MS = 15 * 60 * 1000
const MAX_ENTRIES = 5000

interface Entry {
  trailId: number
  expires: number
  body: unknown
}

const entries = new Map<string, Entry>()

function keyOf(trailId: number, page: string): string {
  return `${trailId}:${page}`
}

/** The cached body for this trail and page, if still fresh. */
export function cachedReviews(trailId: number, page: string, now: number = Date.now()): unknown | undefined {
  const key = keyOf(trailId, page)
  const entry = entries.get(key)
  if (!entry)
    return undefined
  if (entry.expires <= now) {
    entries.delete(key)
    return undefined
  }
  return entry.body
}

export function cacheReviews(trailId: number, page: string, body: unknown, now: number = Date.now()): void {
  const key = keyOf(trailId, page)
  entries.delete(key) // re-inserting moves it to the newest end
  entries.set(key, { trailId, expires: now + REVIEW_CACHE_TTL_MS, body })
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (oldest === undefined)
      break
    entries.delete(oldest)
  }
}

/** Forget every cached page of these trails' reviews. */
export function invalidateTrailReviews(...trailIds: number[]): void {
  const ids = new Set(trailIds.map(Number).filter(id => Number.isInteger(id) && id > 0))
  if (!ids.size)
    return
  for (const [key, entry] of entries) {
    if (ids.has(entry.trailId))
      entries.delete(key)
  }
}

/** For tests. */
export function clearReviewCache(): void {
  entries.clear()
}

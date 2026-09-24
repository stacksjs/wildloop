import { beforeEach, describe, expect, it } from 'bun:test'
import { cachedReviews, cacheReviews, clearReviewCache, invalidateTrailReviews, REVIEW_CACHE_TTL_MS } from '../../app/Support/reviewCache'

describe('review cache', () => {
  beforeEach(() => clearReviewCache())

  it('keeps a trail page of reviews for 15 minutes', () => {
    expect(REVIEW_CACHE_TTL_MS).toBe(15 * 60 * 1000)
    cacheReviews(7, ':', { reviews: [1] }, 0)
    expect(cachedReviews(7, ':', REVIEW_CACHE_TTL_MS - 1)).toEqual({ reviews: [1] })
    expect(cachedReviews(7, ':', REVIEW_CACHE_TTL_MS)).toBeUndefined()
  })

  it('keys by page, so a paginated read does not answer the full one', () => {
    cacheReviews(7, '10:0', { reviews: ['page'] })
    expect(cachedReviews(7, ':')).toBeUndefined()
  })

  it('forgets a trail at once when it is invalidated, and only that trail', () => {
    cacheReviews(7, ':', { reviews: [1] })
    cacheReviews(7, '10:0', { reviews: [1] })
    cacheReviews(8, ':', { reviews: [2] })
    invalidateTrailReviews(7)
    expect(cachedReviews(7, ':')).toBeUndefined()
    expect(cachedReviews(7, '10:0')).toBeUndefined()
    expect(cachedReviews(8, ':')).toEqual({ reviews: [2] })
  })
})

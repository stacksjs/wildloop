import Review from '../Models/Review'
import Trail from '../Models/Trail'

/** Rebuild the catalog rating after a review is written or removed. */
export async function rebuildTrailReviewRating(trailId: number): Promise<{ id: number, rating: number, reviewCount: number }> {
  const reviews = await Review.where('trail_id', '=', trailId).get()
  const reviewCount = reviews.length
  const rating = reviewCount
    ? Math.round(reviews.reduce((sum, review) => sum + (review.rating ?? 0), 0) / reviewCount * 10) / 10
    : 0
  await Trail.forceUpdate(trailId, { rating, review_count: reviewCount })
  return { id: trailId, rating, reviewCount }
}

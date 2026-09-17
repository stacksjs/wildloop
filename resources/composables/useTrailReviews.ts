import { onMount, state } from 'stx'
import { fetchTrailReviews, postTrailReview } from '../assets/scripts/game-api'

/**
 * Trail reviews (#981): hydrate the detail page's review list from the API
 * (falling back to the store's seed reviews) and drive the submission form.
 * The backend upserts one review per user per trail and recomputes the
 * trail's rating/review_count, which we mirror into the store on success.
 */

interface ReviewRow {
  id: number
  trail_id: number
  user_id: number
  userName: string
  rating: number
  text: string
  conditions: string
  created_at: string
  /** As stored: a JSON array, a comma-separated list or a single URL. */
  photos?: unknown
}

interface ReviewStoreLike {
  currentUserId: () => number
  findUser: (id: number) => { name: string } | undefined
  reviews: () => ReviewRow[]
  setTrailRating: (trailId: number, rating: number, reviewCount: number) => void
}

export const REVIEW_CONDITION_OPTIONS = ['excellent', 'good', 'fair', 'poor', 'muddy', 'icy']

export function useTrailReviews(wl: ReviewStoreLike | null, trailId: () => number) {
  const reviews = state<ReviewRow[]>([])
  const reviewSource = state<'api' | 'seed'>('seed')
  const formRating = state(0)
  const formContent = state('')
  const formConditions = state('')
  const submittingReview = state(false)
  const reviewError = state<string | null>(null)
  const reviewSaved = state(false)

  function mapApiReview(r: any): ReviewRow {
    return {
      id: r.id,
      trail_id: trailId(),
      user_id: r.userId,
      userName: r.userName ?? 'Unknown',
      rating: r.rating ?? 0,
      text: r.content ?? '',
      conditions: r.conditions ?? '',
      created_at: r.createdAt ?? new Date().toISOString(),
      photos: r.photos ?? null,
    }
  }

  onMount(async () => {
    if (!wl)
      return
    reviews.set(wl.reviews().filter(r => r.trail_id === trailId()))
    const rows = await fetchTrailReviews(trailId())
    if (rows) {
      reviews.set(rows.map(mapApiReview))
      reviewSource.set('api')
    }
  })

  async function submitReview() {
    if (!wl || submittingReview())
      return
    const rating = formRating()
    const content = formContent().trim()
    if (rating < 1 || rating > 5) {
      reviewError.set('Pick a star rating first')
      return
    }
    if (content.length < 10) {
      reviewError.set('Tell us a little more: at least 10 characters')
      return
    }

    submittingReview.set(true)
    reviewError.set(null)
    const res = await postTrailReview(trailId(), {
      rating,
      content,
      conditions: formConditions() || null,
    })
    submittingReview.set(false)

    if (!res || !res.success || !res.review) {
      reviewError.set(res?.error ?? 'Could not save your review')
      return
    }

    // Upsert semantics: replace any previous review by this user, then
    // mirror the recomputed trail aggregates into the store.
    const me = wl.currentUserId()
    const mine = mapApiReview({ ...res.review, userName: wl.findUser(me)?.name ?? res.review.userName })
    reviews.set([mine, ...reviews().filter(r => r.user_id !== me)])
    if (res.trail)
      wl.setTrailRating(res.trail.id, res.trail.rating, res.trail.reviewCount)
    formContent.set('')
    formConditions.set('')
    formRating.set(0)
    reviewSaved.set(true)
    setTimeout(() => reviewSaved.set(false), 2500)
  }

  return {
    reviews,
    reviewSource,
    formRating,
    formContent,
    formConditions,
    submittingReview,
    reviewError,
    reviewSaved,
    submitReview,
  }
}

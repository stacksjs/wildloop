import { onMount, state } from 'stx'
import { fetchTrailReviewPage, postTrailReview, uploadTrailPhoto } from '../assets/scripts/game-api'
import type { DifficultyTally } from '../functions/review-form'
import { REVIEW_PHOTO_LIMIT, reviewFormError } from '../functions/review-form'
import { TRAIL_CONDITIONS } from '../functions/trail-conditions'

/**
 * Trail reviews (#981): hydrate the detail page's review list from the API
 * (falling back to the store's seed reviews) and drive the "Leave a review"
 * sheet. The backend upserts one review per user per trail and recomputes the
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
  difficulty: string
  created_at: string
  /** The day of the visit, when given: when the conditions were seen. */
  visitDate?: string | null
  /** As stored: a JSON array, a comma-separated list or a single URL. */
  photos?: unknown
}

interface ReviewStoreLike {
  currentUserId: () => number
  findUser: (id: number) => { name: string } | undefined
  reviews: () => ReviewRow[]
  setTrailRating: (trailId: number, rating: number, reviewCount: number) => void
}

/** A photo chosen in the sheet, and its stored id once it has been uploaded. */
export interface ReviewPhotoDraft {
  file: File
  preview: string
  uploadedId: string | null
}

/** What a review can report, from the shared list (weather and hazards too). */
export const REVIEW_CONDITION_OPTIONS = TRAIL_CONDITIONS

export function useTrailReviews(wl: ReviewStoreLike | null, trailId: () => number) {
  const reviews = state<ReviewRow[]>([])
  const reviewSource = state<'api' | 'seed'>('seed')
  const difficultyTally = state<DifficultyTally | null>(null)

  const reviewSheetOpen = state(false)
  const formRating = state(0)
  const formContent = state('')
  const formConditions = state('')
  const formDifficulty = state('')
  const formPhotos = state<ReviewPhotoDraft[]>([])
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
      difficulty: r.difficulty ?? '',
      created_at: r.createdAt ?? new Date().toISOString(),
      visitDate: r.visitDate ?? null,
      photos: r.photos ?? null,
    }
  }

  async function loadReviews(): Promise<void> {
    const page = await fetchTrailReviewPage(trailId())
    if (!page)
      return
    reviews.set(page.reviews.map(mapApiReview))
    difficultyTally.set(page.difficulty)
    reviewSource.set('api')
  }

  onMount(async () => {
    if (!wl)
      return
    reviews.set(wl.reviews().filter(r => r.trail_id === trailId()))
    await loadReviews()
  })

  function releasePhotos(drafts: ReviewPhotoDraft[]): void {
    for (const draft of drafts)
      URL.revokeObjectURL(draft.preview)
  }

  function resetForm(): void {
    releasePhotos(formPhotos())
    formPhotos.set([])
    formContent.set('')
    formConditions.set('')
    formDifficulty.set('')
    formRating.set(0)
    reviewError.set(null)
  }

  /**
   * Open the sheet. There is one review per person per trail, so someone who
   * already wrote one edits it rather than starting over.
   */
  function openReviewSheet(): void {
    const mine = wl ? reviews().find(r => r.user_id === wl.currentUserId()) : undefined
    if (mine && formRating() === 0 && !formContent()) {
      formRating.set(mine.rating)
      formContent.set(mine.text)
      formConditions.set(mine.conditions)
      formDifficulty.set(mine.difficulty)
    }
    reviewError.set(null)
    reviewSheetOpen.set(true)
  }

  function closeReviewSheet(): void {
    reviewSheetOpen.set(false)
  }

  function addReviewPhotos(files: FileList | File[] | null | undefined): void {
    if (!files)
      return
    const room = REVIEW_PHOTO_LIMIT - formPhotos().length
    const picked = Array.from(files).filter(file => file.type.startsWith('image/')).slice(0, Math.max(0, room))
    if (!picked.length) {
      if (room <= 0)
        reviewError.set(`You can add up to ${REVIEW_PHOTO_LIMIT} photos to a review.`)
      return
    }
    formPhotos.set([...formPhotos(), ...picked.map(file => ({ file, preview: URL.createObjectURL(file), uploadedId: null }))])
  }

  function removeReviewPhoto(index: number): void {
    const drafts = formPhotos()
    const draft = drafts[index]
    if (!draft)
      return
    URL.revokeObjectURL(draft.preview)
    formPhotos.set(drafts.filter((_, i) => i !== index))
  }

  /**
   * Upload whatever has not been uploaded yet, one at a time. A photo that
   * made it keeps its id, so trying again after a failure does not upload it
   * twice.
   */
  async function uploadPendingPhotos(): Promise<string | null> {
    const drafts = [...formPhotos()]
    for (let i = 0; i < drafts.length; i++) {
      if (drafts[i].uploadedId)
        continue
      const res = await uploadTrailPhoto(trailId(), drafts[i].file)
      if (!res.success || !res.photo)
        return res.error ?? 'A photo could not be uploaded.'
      drafts[i] = { ...drafts[i], uploadedId: res.photo.id }
      formPhotos.set([...drafts])
    }
    return null
  }

  async function submitReview() {
    if (!wl || submittingReview())
      return
    const problem = reviewFormError(formRating(), formContent())
    if (problem) {
      reviewError.set(problem)
      return
    }

    submittingReview.set(true)
    reviewError.set(null)

    const uploadProblem = await uploadPendingPhotos()
    if (uploadProblem) {
      submittingReview.set(false)
      reviewError.set(uploadProblem)
      return
    }

    const photoIds = formPhotos().map(draft => draft.uploadedId).filter((id): id is string => Boolean(id))
    const res = await postTrailReview(trailId(), {
      rating: formRating(),
      content: formContent().trim(),
      conditions: formConditions() || null,
      difficulty: formDifficulty() || null,
      // Only sent when photos were added, so editing a review without touching
      // its photos keeps the ones it already has.
      ...(photoIds.length ? { photo_ids: photoIds } : {}),
    })
    submittingReview.set(false)

    if (!res || !res.success || !res.review) {
      const field = res?.fields ? Object.values(res.fields)[0] : null
      reviewError.set(field ?? res?.error ?? 'Could not save your review.')
      return
    }

    // Upsert semantics: replace any previous review by this user, then
    // mirror the recomputed trail aggregates into the store.
    const me = wl.currentUserId()
    const mine = mapApiReview({ ...res.review, userName: wl.findUser(me)?.name ?? res.review.userName })
    reviews.set([mine, ...reviews().filter(r => r.user_id !== me)])
    if (res.trail)
      wl.setTrailRating(res.trail.id, res.trail.rating, res.trail.reviewCount)

    resetForm()
    reviewSheetOpen.set(false)
    reviewSaved.set(true)
    setTimeout(() => reviewSaved.set(false), 2500)
    // The vote changed the tally; the list itself is already current.
    void loadReviews()
  }

  return {
    reviews,
    reviewSource,
    difficultyTally,
    reviewSheetOpen,
    formRating,
    formContent,
    formConditions,
    formDifficulty,
    formPhotos,
    submittingReview,
    reviewError,
    reviewSaved,
    openReviewSheet,
    closeReviewSheet,
    addReviewPhotos,
    removeReviewPhoto,
    submitReview,
  }
}

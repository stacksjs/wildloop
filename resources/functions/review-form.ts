/**
 * The rules of the "Leave a review" sheet, kept out of the template so they
 * can be tested. The server enforces the same limits in
 * app/Actions/Trail/TrailReviewStoreAction.ts; these exist so the sheet can
 * say what is wrong before anything is uploaded.
 */

export const REVIEW_CONTENT_MIN = 10
export const REVIEW_CONTENT_MAX = 2000
/** Matches MAX_REVIEW_PHOTOS in the store action. */
export const REVIEW_PHOTO_LIMIT = 10

export type ReviewDifficulty = 'easy' | 'moderate' | 'hard'

export const REVIEW_DIFFICULTY_OPTIONS: ReadonlyArray<{ value: ReviewDifficulty, label: string }> = [
  { value: 'easy', label: 'Easy' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'hard', label: 'Hard' },
]

export interface DifficultyTally {
  easy: number
  moderate: number
  hard: number
  total: number
  consensus: ReviewDifficulty | null
}

/** What stops the review being sent, or null when it can go. */
export function reviewFormError(rating: number, content: string): string | null {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5)
    return 'Pick a star rating first.'
  const length = content.trim().length
  if (length < REVIEW_CONTENT_MIN)
    return `Tell others a little more: at least ${REVIEW_CONTENT_MIN} characters.`
  if (length > REVIEW_CONTENT_MAX)
    return `Keep it under ${REVIEW_CONTENT_MAX} characters.`
  return null
}

export function difficultyLabel(value: unknown): string {
  return REVIEW_DIFFICULTY_OPTIONS.find(option => option.value === value)?.label ?? ''
}

/**
 * One line for the reviews tab, e.g. "Reviewers say Moderate (5 votes)".
 * A tied vote is shown as a split rather than resolved either way.
 */
export function difficultyTallyText(tally: DifficultyTally | null | undefined): string {
  if (!tally || tally.total === 0)
    return ''
  const votes = `${tally.total} ${tally.total === 1 ? 'vote' : 'votes'}`
  if (tally.consensus)
    return `Reviewers say ${difficultyLabel(tally.consensus)} (${votes})`
  const split = REVIEW_DIFFICULTY_OPTIONS
    .filter(option => tally[option.value] > 0)
    .map(option => `${tally[option.value]} ${option.label.toLowerCase()}`)
    .join(', ')
  return `Reviewers are split: ${split}`
}

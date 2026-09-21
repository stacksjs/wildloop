/**
 * How hard the people who walked a trail found it.
 *
 * A trail's own `difficulty` is inferred from distance alone, because the
 * source data carries no ascent for nearly every trail. Reviewers are better
 * witnesses, so each review can carry a vote and the trail page shows the
 * tally beside the inferred grade.
 */

export const REVIEW_DIFFICULTIES = ['easy', 'moderate', 'hard'] as const

export type ReviewDifficulty = typeof REVIEW_DIFFICULTIES[number]

export interface DifficultySummary {
  easy: number
  moderate: number
  hard: number
  total: number
  /** The level with the most votes, or null when nobody voted or the top is tied. */
  consensus: ReviewDifficulty | null
}

export function isReviewDifficulty(value: unknown): value is ReviewDifficulty {
  return typeof value === 'string' && (REVIEW_DIFFICULTIES as readonly string[]).includes(value)
}

/**
 * Tally the votes. A tie at the top has no consensus: calling a split
 * between "easy" and "hard" either one would mislead half the people
 * reading it.
 */
export function summarizeDifficulty(votes: readonly unknown[]): DifficultySummary {
  const summary: DifficultySummary = { easy: 0, moderate: 0, hard: 0, total: 0, consensus: null }

  for (const vote of votes) {
    if (!isReviewDifficulty(vote))
      continue
    summary[vote]++
    summary.total++
  }

  const top = Math.max(summary.easy, summary.moderate, summary.hard)
  if (top === 0)
    return summary

  const leaders = REVIEW_DIFFICULTIES.filter(level => summary[level] === top)
  summary.consensus = leaders.length === 1 ? leaders[0] : null
  return summary
}

import { describe, expect, it } from 'bun:test'
import { isReviewDifficulty, summarizeDifficulty } from '../../app/Support/reviewDifficulty'
import { difficultyTallyText, reviewFormError } from '../../resources/functions/review-form'

describe('review difficulty votes', () => {
  it('counts only the three levels', () => {
    expect(isReviewDifficulty('moderate')).toBe(true)
    expect(isReviewDifficulty('brutal')).toBe(false)
    expect(isReviewDifficulty(null)).toBe(false)

    const tally = summarizeDifficulty(['easy', 'hard', 'brutal', null, undefined, 'hard'])
    expect(tally).toEqual({ easy: 1, moderate: 0, hard: 2, total: 3, consensus: 'hard' })
  })

  it('has no consensus when nobody voted', () => {
    expect(summarizeDifficulty([])).toEqual({ easy: 0, moderate: 0, hard: 0, total: 0, consensus: null })
  })

  it('calls a tie at the top a split rather than picking a side', () => {
    // Emerald Lake in the seed data: one reviewer found it easy, one moderate.
    // Calling it either would mislead half the people reading it.
    expect(summarizeDifficulty(['easy', 'moderate']).consensus).toBeNull()
    expect(summarizeDifficulty(['easy', 'moderate', 'moderate']).consensus).toBe('moderate')
  })

  it('describes the tally in one honest line', () => {
    expect(difficultyTallyText(null)).toBe('')
    expect(difficultyTallyText({ easy: 0, moderate: 0, hard: 0, total: 0, consensus: null })).toBe('')
    expect(difficultyTallyText({ easy: 0, moderate: 1, hard: 0, total: 1, consensus: 'moderate' })).toBe('Reviewers say Moderate (1 vote)')
    expect(difficultyTallyText({ easy: 1, moderate: 2, hard: 0, total: 3, consensus: 'moderate' })).toBe('Reviewers say Moderate (3 votes)')
    expect(difficultyTallyText({ easy: 1, moderate: 1, hard: 0, total: 2, consensus: null })).toBe('Reviewers are split: 1 easy, 1 moderate')
  })
})

describe('the review sheet rules', () => {
  it('asks for a star rating before anything else', () => {
    expect(reviewFormError(0, 'A long enough review.')).toBe('Pick a star rating first.')
    expect(reviewFormError(6, 'A long enough review.')).toBe('Pick a star rating first.')
    expect(reviewFormError(2.5, 'A long enough review.')).toBe('Pick a star rating first.')
  })

  it('holds the same length limits as the server', () => {
    expect(reviewFormError(4, '   too short   ')).toContain('at least 10 characters')
    expect(reviewFormError(4, 'x'.repeat(2001))).toContain('under 2000 characters')
    expect(reviewFormError(4, 'Worth the early start.')).toBeNull()
  })
})

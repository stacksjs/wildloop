import { describe, expect, it } from 'bun:test'
import { avatarInitial, avatarTint, newReviewsLabel, overflowLabel } from '../../resources/functions/avatars'

describe('avatar initial', () => {
  it('is the first letter, upper case', () => {
    expect(avatarInitial('sarah chen')).toBe('S')
    expect(avatarInitial('  ada ')).toBe('A')
  })

  it('keeps a whole character rather than half a code point', () => {
    expect(avatarInitial('🏔 Summit Club')).toBe('🏔')
    expect(avatarInitial('Ötzi')).toBe('Ö')
  })

  it('has something to show for a nameless account', () => {
    expect(avatarInitial('')).toBe('·')
    expect(avatarInitial(null)).toBe('·')
  })
})

describe('avatar tint', () => {
  it('gives one person the same colour every time', () => {
    expect(avatarTint(42)).toBe(avatarTint(42))
    expect(avatarTint('Ada')).toBe(avatarTint('Ada'))
  })

  it('spreads different people across the palette', () => {
    const tints = new Set([1, 2, 3, 4, 5, 6, 7, 8].map(id => avatarTint(id)))
    expect(tints.size).toBeGreaterThan(1)
  })

  it('always returns a tint the stylesheet defines', () => {
    expect(avatarTint(null)).toMatch(/^avatar-tint-[0-5]$/)
    expect(avatarTint('')).toMatch(/^avatar-tint-[0-5]$/)
    expect(avatarTint('Ada')).toMatch(/^avatar-tint-[0-5]$/)
  })
})

describe('review count labels', () => {
  it('counts in words a card can show', () => {
    expect(newReviewsLabel(31)).toBe('31 new reviews')
    expect(newReviewsLabel(1)).toBe('1 new review')
    expect(newReviewsLabel(1234)).toBe('1,234 new reviews')
  })

  it('says nothing when nothing is new', () => {
    expect(newReviewsLabel(0)).toBe('')
    expect(newReviewsLabel(-4)).toBe('')
    expect(newReviewsLabel(Number.NaN)).toBe('')
  })

  it('counts only the faces that did not fit', () => {
    expect(overflowLabel(31, 3)).toBe('+28')
    expect(overflowLabel(3, 3)).toBe('')
    expect(overflowLabel(2, 3)).toBe('')
    expect(overflowLabel(5000, 3)).toBe('+99')
  })
})

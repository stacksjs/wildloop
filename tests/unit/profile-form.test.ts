import { describe, expect, it } from 'bun:test'
import { characterCount, PROFILE_LIMITS, validateProfileInput } from '../../resources/functions/profile-form'

describe('validateProfileInput', () => {
  it('cleans what it accepts', () => {
    expect(validateProfileInput({ name: '  Kim   Gottwald ', bio: '  Hills.\r\nMore hills.  ', location: ' Boulder,   CO ' })).toEqual({
      value: { name: 'Kim Gottwald', bio: 'Hills.\nMore hills.', location: 'Boulder, CO' },
    })
  })

  it('clears an empty bio or location rather than storing blanks', () => {
    expect(validateProfileInput({ name: 'Kim', bio: '   ', location: '' })).toEqual({
      value: { name: 'Kim', bio: null, location: null },
    })
  })

  it('names each field that is wrong', () => {
    const result = validateProfileInput({
      name: 'K',
      bio: 'x'.repeat(PROFILE_LIMITS.bio + 1),
      location: 'y'.repeat(PROFILE_LIMITS.location + 1),
    })
    expect('errors' in result && Object.keys(result.errors).sort()).toEqual(['bio', 'location', 'name'])
  })

  it('counts characters, not UTF-16 units, against the limits', () => {
    expect('value' in validateProfileInput({ name: 'Kim', bio: '🏔'.repeat(PROFILE_LIMITS.bio) })).toBe(true)
    expect(characterCount('🏔🏔', 280)).toBe('2 / 280')
  })
})

import { describe, expect, it } from 'bun:test'
import { passwordChangeError, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../resources/functions/password-change'

describe('password change rules', () => {
  it('accepts a change that satisfies every rule', () => {
    expect(passwordChangeError('old-one-here', 'a-brand-new-one', 'a-brand-new-one')).toBe('')
  })

  it('asks for the field the person still has to fill in', () => {
    expect(passwordChangeError('', 'a-brand-new-one', 'a-brand-new-one')).toBe('Enter your current password.')
    expect(passwordChangeError('old-one-here', '', '')).toBe('Enter a new password.')
  })

  it('holds the line at the minimum length, and one character either side of it', () => {
    const short = 'a'.repeat(PASSWORD_MIN_LENGTH - 1)
    const exact = 'a'.repeat(PASSWORD_MIN_LENGTH)

    expect(passwordChangeError('old-one-here', short, short)).toBe(`Your new password must be at least ${PASSWORD_MIN_LENGTH} characters.`)
    expect(passwordChangeError('old-one-here', exact, exact)).toBe('')
  })

  it('refuses a password longer than the column can hold', () => {
    const long = 'a'.repeat(PASSWORD_MAX_LENGTH + 1)
    const limit = 'a'.repeat(PASSWORD_MAX_LENGTH)

    expect(passwordChangeError('old-one-here', long, long)).toBe(`Your new password must be ${PASSWORD_MAX_LENGTH} characters or fewer.`)
    expect(passwordChangeError('old-one-here', limit, limit)).toBe('')
  })

  it('refuses the password already in use, which would report success and change nothing', () => {
    expect(passwordChangeError('same-password', 'same-password', 'same-password'))
      .toBe('Your new password must be different from your current one.')
  })

  it('catches a typo in the confirmation', () => {
    expect(passwordChangeError('old-one-here', 'a-brand-new-one', 'a-brand-new-onf'))
      .toBe('The new passwords do not match.')
  })

  it('never trims: a password is the bytes the person typed', () => {
    expect(passwordChangeError('old-one-here', ' padded password ', ' padded password ')).toBe('')
    expect(passwordChangeError('old-one-here', ' padded password ', 'padded password'))
      .toBe('The new passwords do not match.')
  })
})

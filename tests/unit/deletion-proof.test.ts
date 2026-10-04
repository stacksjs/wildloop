import { describe, expect, it } from 'bun:test'
import { hasOwnPassword } from '../../app/Support/accountPassword'
import { DELETE_CONFIRMATION, deletionProof, providerNames, RECENT_SIGN_IN_MS, sessionIsRecent } from '../../app/Support/deletionProof'

/**
 * Who has to type what to delete their account (App Store 5.1.1(v)).
 *
 * An account Google or Apple made has a random password nobody ever saw, so
 * asking it for "your password" made deletion impossible for exactly the
 * people Apple reviews with. They type DELETE from a fresh sign-in instead,
 * and everyone with a real password keeps the password check.
 */

const NOW = Date.parse('2026-10-04T12:00:00Z')
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000)

describe('whether an account has a password of its own', () => {
  it('has one when it was registered, whatever it later linked', () => {
    expect(hasOwnPassword({ createdByProvider: false, passwordChangedAt: null })).toBe(true)
  })

  it('has none when a provider sign-in made it and nobody has set one', () => {
    expect(hasOwnPassword({ createdByProvider: true, passwordChangedAt: null })).toBe(false)
  })

  it('has one once its owner sets one through the reset flow', () => {
    expect(hasOwnPassword({ createdByProvider: true, passwordChangedAt: '2026-09-01 10:00:00' })).toBe(true)
  })
})

describe('an account with a password', () => {
  const base = { hasPassword: true, providers: [], confirmation: '', sessionIssuedAt: minutesAgo(600), now: NOW } as const

  it('is asked for it, exactly as before', () => {
    expect(deletionProof({ ...base, password: 'correct horse' })).toEqual({ kind: 'password', password: 'correct horse' })
  })

  it('is refused without it, and told what to type', () => {
    const proof = deletionProof({ ...base, password: '' })
    expect(proof).toMatchObject({ kind: 'refused', status: 422, body: { error: 'Enter your password to delete your account.' } })
  })

  it('cannot use the word DELETE in place of the password, however fresh the session', () => {
    const proof = deletionProof({ ...base, password: '', confirmation: 'DELETE', sessionIssuedAt: minutesAgo(1) })
    expect(proof.kind).toBe('refused')
  })
})

describe('an account Google or Apple made', () => {
  const base = { hasPassword: false, providers: ['apple'], password: '', confirmation: 'DELETE', sessionIssuedAt: minutesAgo(2), now: NOW } as const

  it('confirms with the word DELETE from a recent sign-in', () => {
    expect(deletionProof(base)).toEqual({ kind: 'confirmed' })
    expect(deletionProof({ ...base, confirmation: '  delete ' })).toEqual({ kind: 'confirmed' })
  })

  it('is asked to type DELETE when it has not, and a password is no substitute', () => {
    for (const attempt of [{ confirmation: '' }, { confirmation: 'yes' }, { confirmation: '', password: 'anything' }]) {
      const proof = deletionProof({ ...base, ...attempt })
      expect(proof).toMatchObject({ kind: 'refused', status: 422, body: { error: `Type ${DELETE_CONFIRMATION} to confirm.`, confirm: 'DELETE' } })
    }
  })

  it('is sent to sign in again with its provider when the session is older than 15 minutes', () => {
    const proof = deletionProof({ ...base, sessionIssuedAt: minutesAgo(16) })
    expect(proof).toMatchObject({ kind: 'refused', status: 403, body: { reason: 'reauthenticate' } })
    if (proof.kind === 'refused')
      expect(proof.body.error).toBe('For your security, sign out, sign in again with Apple, and then delete your account within 15 minutes.')
  })

  it('is refused when nobody can say when the session began', () => {
    expect(deletionProof({ ...base, sessionIssuedAt: null })).toMatchObject({ kind: 'refused', status: 403 })
    expect(deletionProof({ ...base, sessionIssuedAt: new Date('not a date') })).toMatchObject({ kind: 'refused', status: 403 })
  })
})

describe('a recent session', () => {
  it('is one issued within the window, edges included', () => {
    expect(sessionIsRecent(minutesAgo(0), NOW)).toBe(true)
    expect(sessionIsRecent(new Date(NOW - RECENT_SIGN_IN_MS), NOW)).toBe(true)
    expect(sessionIsRecent(new Date(NOW - RECENT_SIGN_IN_MS - 1), NOW)).toBe(false)
  })

  it('allows a minute of clock skew, and no more', () => {
    expect(sessionIsRecent(new Date(NOW + 30_000), NOW)).toBe(true)
    expect(sessionIsRecent(new Date(NOW + 10 * 60_000), NOW)).toBe(false)
  })
})

describe('naming the provider to sign in with', () => {
  it('names the one the account uses, both when it has both, and both when it is not known', () => {
    expect(providerNames(['google'])).toBe('Google')
    expect(providerNames(['apple', 'google', 'apple'])).toBe('Apple or Google')
    expect(providerNames([])).toBe('Google or Apple')
  })
})

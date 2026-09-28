import { describe, expect, it } from 'bun:test'
import {
  authorizeUrl,
  decideLink,
  profileFromClaims,
  STATE_LIFETIME_MS,
  stateIsAcceptable,
} from '../../app/Support/socialIdentity'

/**
 * Signing in with Google, at the point where it can go wrong quietly.
 *
 * Every case here is one where the feature still appears to work and has in
 * fact handed somebody an account, so none of them would be caught by trying
 * it once and seeing a session.
 */

const verified = { sub: '10769150350006150715', email: 'ada@example.com', emailVerified: true, name: 'Ada Lovelace' }

describe('decideLink', () => {
  it('signs in a Google account that has been here before, without consulting the address', () => {
    // By subject id, deliberately: the address on a Google account can change,
    // and the person is the same person when it does.
    expect(decideLink({ ...verified, email: 'ada+new@example.com' }, 42, null)).toEqual({ action: 'sign-in', userId: 42 })
  })

  it('makes an account when the address is new', () => {
    expect(decideLink(verified, null, null)).toEqual({ action: 'create', email: 'ada@example.com', name: 'Ada Lovelace' })
  })

  it('links to the account that already has the address', () => {
    expect(decideLink(verified, null, { id: 7, email: 'ada@example.com' })).toEqual({ action: 'link', userId: 7 })
  })

  /*
   * The one that matters.
   *
   * Linking by address hands somebody an existing account on the strength of a
   * claim. Google only vouches for an address when `email_verified` is true;
   * without it the value is a string somebody typed, and honouring it would
   * let anyone who can type another person's address take their account.
   */
  it('refuses to link an address Google has not verified', () => {
    const unverified = { ...verified, emailVerified: false }
    expect(decideLink(unverified, null, { id: 7, email: 'ada@example.com' })).toEqual({ action: 'refuse', reason: 'unverified-email' })
  })

  it('refuses to create an account from an unverified address too', () => {
    // Not merely a linking rule: an account created from an address nobody
    // proved is an account the real owner can never claim back.
    expect(decideLink({ ...verified, emailVerified: false }, null, null)).toEqual({ action: 'refuse', reason: 'unverified-email' })
  })

  it('refuses a profile with no address at all', () => {
    expect(decideLink({ ...verified, email: '' }, null, null)).toEqual({ action: 'refuse', reason: 'no-email' })
  })

  it('still signs in a known identity whose address has gone missing', () => {
    // The identity is the proof, so a profile that arrives without an address
    // is not a reason to lock somebody out of the account they already have.
    expect(decideLink({ ...verified, email: '', emailVerified: false }, 42, null)).toEqual({ action: 'sign-in', userId: 42 })
  })

  it('matches an address regardless of case or surrounding space', () => {
    expect(decideLink({ ...verified, email: '  Ada@Example.COM ' }, null, { id: 7, email: 'ada@example.com' }))
      .toEqual({ action: 'link', userId: 7 })
  })

  it('names somebody from their address when Google sends no name', () => {
    expect(decideLink({ ...verified, name: '   ' }, null, null)).toEqual({ action: 'create', email: 'ada@example.com', name: 'ada' })
  })
})

describe('stateIsAcceptable', () => {
  const issued = { value: 'a'.repeat(32), createdAt: 1_000_000 }

  it('accepts the state it issued, once', () => {
    expect(stateIsAcceptable(issued, issued.value, issued.createdAt + 1000)).toBe(true)
  })

  it('refuses a state it did not issue', () => {
    expect(stateIsAcceptable(issued, 'b'.repeat(32), issued.createdAt)).toBe(false)
    expect(stateIsAcceptable(null, 'b'.repeat(32), issued.createdAt)).toBe(false)
    expect(stateIsAcceptable(issued, '', issued.createdAt)).toBe(false)
  })

  it('refuses a prefix of the state it issued', () => {
    // Compared in full: a check that passes on a prefix is a check somebody
    // can pass by guessing one character at a time.
    expect(stateIsAcceptable(issued, issued.value.slice(0, 31), issued.createdAt)).toBe(false)
  })

  it('refuses a state too short to be unguessable, even if it matches', () => {
    const weak = { value: 'abc', createdAt: 1_000_000 }
    expect(stateIsAcceptable(weak, 'abc', weak.createdAt)).toBe(false)
  })

  it('refuses one left over from an abandoned sign-in', () => {
    expect(stateIsAcceptable(issued, issued.value, issued.createdAt + STATE_LIFETIME_MS + 1)).toBe(false)
  })

  it('refuses one that claims to come from the future', () => {
    expect(stateIsAcceptable(issued, issued.value, issued.createdAt - 1)).toBe(false)
  })
})

describe('authorizeUrl', () => {
  const url = () => new URL(authorizeUrl({ clientId: 'cid', redirectUri: 'https://wildloop.org/api/auth/google/callback', state: 's'.repeat(32) }))

  it('asks Google for identity and nothing more', () => {
    // Only the scopes that say who somebody is. Anything beyond these is a
    // consent screen that asks for more than the feature needs, and a
    // verification review we would then have to pass.
    expect(url().searchParams.get('scope')).toBe('openid email profile')
  })

  it('carries the client, the exact redirect and the state', () => {
    const params = url().searchParams
    expect(params.get('client_id')).toBe('cid')
    expect(params.get('redirect_uri')).toBe('https://wildloop.org/api/auth/google/callback')
    expect(params.get('state')).toBe('s'.repeat(32))
    expect(params.get('response_type')).toBe('code')
  })

  it('always shows the account chooser', () => {
    // Without this, a browser already signed into one Google account is sent
    // straight back signed in as that one — so somebody reaching for their
    // other account gets silently signed in as the wrong person.
    expect(url().searchParams.get('prompt')).toBe('select_account')
  })
})

describe('profileFromClaims', () => {
  it('takes what it needs from a token and ignores the rest', () => {
    expect(profileFromClaims({
      sub: '123',
      email: 'Ada@Example.com',
      email_verified: true,
      name: 'Ada',
      picture: 'https://example.com/a.jpg',
      hd: 'example.com',
      aud: 'something',
    })).toEqual({ sub: '123', email: 'ada@example.com', emailVerified: true, name: 'Ada', picture: 'https://example.com/a.jpg' })
  })

  it('reads the string "true" as verified, which Google has sent', () => {
    expect(profileFromClaims({ sub: '1', email: 'a@b.c', email_verified: 'true' })?.emailVerified).toBe(true)
  })

  it('treats anything else as unverified rather than truthy', () => {
    // `"false"` is a non-empty string, so a plain truthiness check would read
    // it as verified — which is the whole account-takeover case above.
    for (const value of ['false', 'yes', 1, 0, null, undefined, {}])
      expect(profileFromClaims({ sub: '1', email: 'a@b.c', email_verified: value })?.emailVerified, String(value)).toBe(false)
  })

  it('is nothing without a subject, because that is the only stable identifier', () => {
    expect(profileFromClaims({ email: 'a@b.c', email_verified: true })).toBeNull()
    expect(profileFromClaims({ sub: '  ', email: 'a@b.c' })).toBeNull()
  })
})

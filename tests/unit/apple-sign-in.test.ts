import { describe, expect, it } from 'bun:test'
import {
  APPLE_ISSUER,
  appleAuthorizeUrl,
  appleClientSecret,
  appleDisplayName,
  appleNameFromUser,
  appleProfileFromClaims,
  pkcs8FromPem,
} from '../../app/Support/appleSignIn'

/**
 * The parts of Sign in with Apple that are not Google's, checked without
 * Apple: the client secret we mint, the claims we accept, and the name that
 * arrives exactly once.
 *
 * The secret is the one most worth a test. Apple's answer to a malformed one
 * is `invalid_client` and nothing more, from a server we cannot debug, so a
 * wrong claim or a mis-encoded signature would surface as "sign-in does not
 * work" on the day the credentials are added. Here it is verified with the
 * public half of a key made for the test.
 */

const CLIENT_ID = 'org.wildloop.signin'

async function testKey(): Promise<{ pem: string, publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')
  const pem = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`
  return { pem, publicKey: pair.publicKey }
}

function decode(segment: string): any {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'))
}

describe('the authorize URL', () => {
  const url = new URL(appleAuthorizeUrl({ clientId: CLIENT_ID, redirectUri: 'https://wildloop.org/api/auth/apple/callback', state: 's'.repeat(64) }))

  it('goes to Apple', () => {
    expect(`${url.origin}${url.pathname}`).toBe('https://appleid.apple.com/auth/authorize')
  })

  /*
   * Apple refuses `scope=name email` with any response mode but form_post, so
   * these two only work together, and they are why the callback is a POST.
   */
  it('asks for the name and address, which obliges a form post back', () => {
    expect(url.searchParams.get('scope')).toBe('name email')
    expect(url.searchParams.get('response_mode')).toBe('form_post')
    expect(url.searchParams.get('response_type')).toBe('code')
  })

  it('carries the client, the redirect URI and the state unchanged', () => {
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe('https://wildloop.org/api/auth/apple/callback')
    expect(url.searchParams.get('state')).toBe('s'.repeat(64))
  })
})

describe('the client secret', () => {
  it('is an ES256 JWT that verifies with the key\'s public half', async () => {
    const { pem, publicKey } = await testKey()
    const secret = await appleClientSecret({ clientId: CLIENT_ID, teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: pem })
    const [header, payload, signature] = secret.split('.')

    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      Buffer.from(signature, 'base64url'),
      new TextEncoder().encode(`${header}.${payload}`),
    )
    expect(valid).toBe(true)
    // JWS wants the raw 64-byte r||s, not DER. Apple rejects DER.
    expect(Buffer.from(signature, 'base64url')).toHaveLength(64)
  })

  it('names the key, the team, the Services ID and Apple, as Apple specifies', async () => {
    const { pem } = await testKey()
    const now = 1_790_000_000
    const secret = await appleClientSecret({ clientId: CLIENT_ID, teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: pem }, now)
    const [header, payload] = secret.split('.')

    expect(decode(header)).toEqual({ alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' })
    expect(decode(payload)).toEqual({ iss: 'TEAM123456', iat: now, exp: now + 300, aud: APPLE_ISSUER, sub: CLIENT_ID })
  })

  it('lives for minutes, far inside Apple\'s six-month ceiling', async () => {
    const { pem } = await testKey()
    const payload = decode((await appleClientSecret({ clientId: CLIENT_ID, teamId: 'T', keyId: 'K', privateKey: pem })).split('.')[1])
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600)
  })

  /*
   * Env files make a multi-line value awkward, so the key arrives however
   * somebody managed to paste it. All three shapes are the same key.
   */
  it('reads the key with newlines, with \\n escapes, or as the bare body', async () => {
    const { pem } = await testKey()
    const escaped = pem.replace(/\n/g, '\\n')
    const bare = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '')
    expect(pkcs8FromPem(escaped)).toEqual(pkcs8FromPem(pem))
    expect(pkcs8FromPem(bare)).toEqual(pkcs8FromPem(pem))
    await appleClientSecret({ clientId: CLIENT_ID, teamId: 'T', keyId: 'K', privateKey: escaped })
  })

  it('fails loudly on a key that is not one', async () => {
    await expect(appleClientSecret({ clientId: CLIENT_ID, teamId: 'T', keyId: 'K', privateKey: '' })).rejects.toThrow()
    await expect(appleClientSecret({ clientId: CLIENT_ID, teamId: 'T', keyId: 'K', privateKey: 'not a key' })).rejects.toThrow()
  })
})

describe('reading Apple\'s id token', () => {
  const CLAIMS = {
    iss: APPLE_ISSUER,
    aud: CLIENT_ID,
    sub: '001234.abcdef0123456789.0123',
    email: 'Ada@iCloud.com',
    email_verified: 'true',
    is_private_email: 'false',
  }

  it('takes the subject, the address and whether Apple verified it', () => {
    expect(appleProfileFromClaims(CLAIMS, CLIENT_ID)).toEqual({
      sub: '001234.abcdef0123456789.0123',
      email: 'ada@icloud.com',
      emailVerified: true,
      isPrivateEmail: false,
      name: null,
      picture: null,
    })
  })

  /*
   * Apple has sent these as strings and as booleans. "false" is a non-empty
   * string, so a truthiness check reads it as verified — the mistake that
   * turns linking by address into taking over an account.
   */
  it('reads "false" as false', () => {
    expect(appleProfileFromClaims({ ...CLAIMS, email_verified: 'false' }, CLIENT_ID)?.emailVerified).toBe(false)
    expect(appleProfileFromClaims({ ...CLAIMS, email_verified: false }, CLIENT_ID)?.emailVerified).toBe(false)
    expect(appleProfileFromClaims({ ...CLAIMS, email_verified: true }, CLIENT_ID)?.emailVerified).toBe(true)
    expect(appleProfileFromClaims({ ...CLAIMS, email_verified: undefined }, CLIENT_ID)?.emailVerified).toBe(false)
  })

  it('knows a Hide My Email relay, by Apple\'s word or by its domain', () => {
    expect(appleProfileFromClaims({ ...CLAIMS, is_private_email: true }, CLIENT_ID)?.isPrivateEmail).toBe(true)
    expect(appleProfileFromClaims({ ...CLAIMS, email: 'x7k2p9q4mz@privaterelay.appleid.com', is_private_email: undefined }, CLIENT_ID)?.isPrivateEmail).toBe(true)
  })

  it('refuses a token Apple did not issue, or issued for another app', () => {
    expect(appleProfileFromClaims({ ...CLAIMS, iss: 'https://accounts.google.com' }, CLIENT_ID)).toBeNull()
    expect(appleProfileFromClaims({ ...CLAIMS, aud: 'com.someone.else' }, CLIENT_ID)).toBeNull()
    expect(appleProfileFromClaims(CLAIMS, '')).toBeNull()
  })

  it('accepts an audience given as a list, as JWTs allow', () => {
    expect(appleProfileFromClaims({ ...CLAIMS, aud: ['other', CLIENT_ID] }, CLIENT_ID)).not.toBeNull()
  })

  it('refuses a token with no subject', () => {
    expect(appleProfileFromClaims({ ...CLAIMS, sub: '' }, CLIENT_ID)).toBeNull()
    expect(appleProfileFromClaims({ ...CLAIMS, sub: 42 }, CLIENT_ID)).toBeNull()
  })
})

describe('the name Apple sends once', () => {
  it('reads the first sign-in\'s user field', () => {
    const user = JSON.stringify({ name: { firstName: 'Ada', lastName: 'Lovelace' }, email: 'ada@icloud.com' })
    expect(appleNameFromUser(user)).toBe('Ada Lovelace')
  })

  it('makes do with half a name', () => {
    expect(appleNameFromUser(JSON.stringify({ name: { firstName: 'Ada' } }))).toBe('Ada')
    expect(appleNameFromUser(JSON.stringify({ name: { lastName: '  Lovelace ' } }))).toBe('Lovelace')
  })

  it('answers nothing for every later sign-in, which has no user field', () => {
    for (const value of [undefined, null, '', '{}', '{"name":{}}', 'not json', 42])
      expect(appleNameFromUser(value), String(value)).toBeNull()
  })

  it('keeps a name to a sensible length', () => {
    const long = JSON.stringify({ name: { firstName: 'A'.repeat(500), lastName: 'B' } })
    expect(appleNameFromUser(long)!.length).toBeLessThanOrEqual(100)
  })

  it('names a relay account something better than its relay address', () => {
    const relay = { sub: 's', email: 'x7k2p9q4mz@privaterelay.appleid.com', emailVerified: true, isPrivateEmail: true }
    const plain = { sub: 's', email: 'ada@icloud.com', emailVerified: true, isPrivateEmail: false }

    expect(appleDisplayName(relay, 'Ada Lovelace')).toBe('Ada Lovelace')
    expect(appleDisplayName(relay, null)).toBe('Wildloop athlete')
    // A real address's local part is a fair guess, and decideLink makes it.
    expect(appleDisplayName(plain, null)).toBeNull()
  })
})

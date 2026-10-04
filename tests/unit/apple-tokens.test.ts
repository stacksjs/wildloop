import { afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { appleRevokeRequest, openToken, revokeAppleToken, revokeAppleTokens, sealToken } from '../../app/Support/appleTokens'

/**
 * Revoking Apple tokens when an account is deleted, which Sign in with Apple
 * requires. Nothing real is contacted: every call is handed its own `fetch`,
 * which records what it was asked and answers as Apple might.
 */

const KEY = 'unit-test-app-key-not-a-real-one'
const REFRESH = 'r.apple-refresh-token-0123456789'
let credentials: { clientId: string, teamId: string, keyId: string, privateKey: string }
let publicKey: CryptoKey

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair
  const pem = `-----BEGIN PRIVATE KEY-----\n${Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64')}\n-----END PRIVATE KEY-----`
  publicKey = pair.publicKey
  credentials = { clientId: 'org.wildloop.signin', teamId: 'TEAM123456', keyId: 'KEY1234567', privateKey: pem }
})

let errors: ReturnType<typeof spyOn> | null = null
afterEach(() => {
  errors?.mockRestore()
  errors = null
})

/** A `fetch` that records each request and answers with `answer`. */
function recorder(answer: () => Response | Promise<Response>) {
  const sent: { url: string, init: RequestInit, form: Record<string, string> }[] = []
  const send = async (url: string, init: RequestInit) => {
    sent.push({ url, init, form: Object.fromEntries(new URLSearchParams(String(init.body))) })
    return await answer()
  }
  return { sent, send }
}

/** Everything written to console.error, as one string. */
function logged(): string {
  return (errors?.mock.calls ?? []).map((call: unknown[]) => call.map(String).join(' ')).join('\n')
}

describe('the revoke request', () => {
  it('is the form Apple documents, naming the token as a refresh token', () => {
    const { url, init } = appleRevokeRequest('org.wildloop.signin', 'minted.jwt.secret', REFRESH)
    expect(url).toBe('https://appleid.apple.com/auth/revoke')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      client_id: 'org.wildloop.signin',
      client_secret: 'minted.jwt.secret',
      token: REFRESH,
      token_type_hint: 'refresh_token',
    })
  })

  it('is signed with a client secret minted from our key, as the token exchange is', async () => {
    const { sent, send } = recorder(() => new Response(null, { status: 200 }))
    const now = Math.floor(Date.now() / 1000)
    expect(await revokeAppleToken(REFRESH, credentials, { fetch: send, now })).toEqual({ ok: true })

    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('https://appleid.apple.com/auth/revoke')
    expect(sent[0].form).toMatchObject({ client_id: 'org.wildloop.signin', token: REFRESH, token_type_hint: 'refresh_token' })
    expect(sent[0].init.signal).toBeInstanceOf(AbortSignal)

    const [header, payload, signature] = sent[0].form.client_secret.split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
      iss: 'TEAM123456',
      sub: 'org.wildloop.signin',
      aud: 'https://appleid.apple.com',
      iat: now,
    })
    const valid = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      Buffer.from(signature, 'base64url'),
      new TextEncoder().encode(`${header}.${payload}`),
    )
    expect(valid).toBe(true)
  })

  it('reports a refusal without the token in it', async () => {
    const { send } = recorder(() => new Response('{"error":"invalid_client"}', { status: 400 }))
    const outcome = await revokeAppleToken(REFRESH, credentials, { fetch: send })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.reason).toContain('400')
      expect(outcome.reason).toContain('invalid_client')
      expect(outcome.reason).not.toContain(REFRESH)
    }
  })

  it('reports an Apple it cannot reach, and does not throw', async () => {
    const outcome = await revokeAppleToken(REFRESH, credentials, { fetch: async () => { throw new TypeError('fetch failed') } })
    expect(outcome).toEqual({ ok: false, reason: 'TypeError: fetch failed' })
  })

  it('reports a key that will not sign, and does not throw', async () => {
    const outcome = await revokeAppleToken(REFRESH, { ...credentials, privateKey: 'not a key' }, { fetch: async () => new Response(null) })
    expect(outcome.ok).toBe(false)
  })
})

describe('the stored token', () => {
  it('is sealed, so the database never holds it as Apple issued it', async () => {
    const sealed = await sealToken(REFRESH, KEY)
    expect(sealed).not.toContain(REFRESH)
    expect(await openToken(sealed, KEY)).toBe(REFRESH)
    await expect(openToken(sealed, 'some-other-key')).rejects.toThrow()
  })
})

describe('revoking on deletion', () => {
  it('revokes every stored token', async () => {
    const { sent, send } = recorder(() => new Response(null, { status: 200 }))
    const sealed = [await sealToken(REFRESH, KEY), await sealToken(`${REFRESH}-older`, KEY)]
    expect(await revokeAppleTokens(sealed, { credentials, fetch: send, key: KEY })).toEqual({ revoked: 2, failed: 0 })
    expect(sent.map(request => request.form.token)).toEqual([REFRESH, `${REFRESH}-older`])
  })

  it('asks nothing of Apple when there is nothing to revoke', async () => {
    const { sent, send } = recorder(() => new Response(null, { status: 200 }))
    expect(await revokeAppleTokens([], { credentials, fetch: send, key: KEY })).toEqual({ revoked: 0, failed: 0 })
    expect(sent).toHaveLength(0)
  })

  it('logs an Apple that is down and carries on, never with the token in the log', async () => {
    errors = spyOn(console, 'error').mockImplementation(() => {})
    const sealed = [await sealToken(REFRESH, KEY), await sealToken(`${REFRESH}-2`, KEY)]
    const outcome = await revokeAppleTokens(sealed, { credentials, key: KEY, fetch: async () => { throw new TypeError('fetch failed') } })
    expect(outcome).toEqual({ revoked: 0, failed: 2 })
    expect(logged()).toContain('could not revoke an Apple token')
    expect(logged()).not.toContain(REFRESH)
    for (const value of sealed)
      expect(logged()).not.toContain(value)
  })

  it('logs a token it cannot unseal, and still revokes the rest', async () => {
    errors = spyOn(console, 'error').mockImplementation(() => {})
    const { sent, send } = recorder(() => new Response(null, { status: 200 }))
    const sealed = ['not-sealed-with-this-key', await sealToken(REFRESH, KEY)]
    expect(await revokeAppleTokens(sealed, { credentials, fetch: send, key: KEY })).toEqual({ revoked: 1, failed: 1 })
    expect(sent).toHaveLength(1)
    expect(logged()).toContain('could not unseal')
  })

  it('logs, rather than fails, when Sign in with Apple has been switched off since', async () => {
    errors = spyOn(console, 'error').mockImplementation(() => {})
    const { sent, send } = recorder(() => new Response(null, { status: 200 }))
    expect(await revokeAppleTokens([await sealToken(REFRESH, KEY)], { credentials: null, fetch: send, key: KEY })).toEqual({ revoked: 0, failed: 1 })
    expect(sent).toHaveLength(0)
    expect(logged()).toContain('not configured')
  })
})

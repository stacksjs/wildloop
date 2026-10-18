import { describe, expect, it } from 'bun:test'
import { createNativeApi, loadOutcome, nativeHeaders, WILDLOOP_ORIGIN } from '../../resources/functions/native-api'

/**
 * The request skeleton twelve native screens were each holding a copy of.
 *
 * Tested directly rather than only through the screens, because the two
 * behaviours worth pinning are easy to get subtly wrong in a copy: an
 * anonymous request carries *no* `Authorization` header rather than an empty
 * one, and the keychain is read once however many requests follow.
 */

/** A `craft.secureStorage` stand-in that counts its reads. */
function keychain(value: unknown) {
  let reads = 0
  return {
    reads: () => reads,
    host: {
      snapshots: { get: () => null },
      secureStorage: {
        get: (key: string) => {
          expect(key).toBe('auth_token')
          reads++
          return value
        },
      },
    },
  }
}

/** A `fetch` stand-in that records what it was asked for. */
function recorder(answer: { status?: number, body?: string } = {}) {
  const calls: any[] = []
  const previous = globalThis.fetch
  globalThis.fetch = (async (url: string, init: any = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null })
    const status = answer.status ?? 200
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(answer.body ?? '{"success":true}'),
    }
  }) as any
  return { calls, restore: () => { globalThis.fetch = previous } }
}

describe('native multipart requests',()=>{
  it('keeps native form data intact and lets the host set the multipart boundary',async()=>{
    const capture=recorder(),keys=keychain('token')
    try {
      const form=new FormData();form.append('photo','test-file-descriptor')
      await createNativeApi(keys.host).upload('/api/trails/7/photos',form)
      expect(capture.calls[0]).toMatchObject({method:'POST',body:form})
      expect(capture.calls[0].headers).toEqual({Accept:'application/json',Authorization:'Bearer token'})
    }finally{capture.restore()}
  })
})

describe('nativeHeaders', () => {
  it('always asks for JSON', () => {
    expect(nativeHeaders('')).toEqual({ Accept: 'application/json' })
  })

  /*
   * An anonymous request is a real case — the records board and the battle
   * feed both answer without a viewer — so an empty token means the header is
   * absent, not present and empty.
   */
  it('leaves the authorization header off when there is no token', () => {
    expect(nativeHeaders('')).not.toHaveProperty('Authorization')
    expect(nativeHeaders('tok_abc')).toMatchObject({ Authorization: 'Bearer tok_abc' })
  })

  it('declares a JSON body only when there is one', () => {
    expect(nativeHeaders('tok', false)).not.toHaveProperty('Content-Type')
    expect(nativeHeaders('tok', true)).toMatchObject({ 'Content-Type': 'application/json' })
  })
})

describe('loadOutcome', () => {
  /*
   * A record that does not exist is an answer, not a failure: the two read
   * differently on screen, "no such territory" against "could not load".
   */
  it('separates a missing record from a failure', () => {
    expect(loadOutcome({ ok: false, status: 404 })).toBe('missing')
    expect(loadOutcome({ ok: false, status: 422 })).toBe('missing')
    expect(loadOutcome({ ok: false, status: 500 })).toBe('error')
    expect(loadOutcome({ ok: false, status: 0 })).toBe('error')
  })

  it('reads an answer as an answer', () => {
    expect(loadOutcome({ ok: true, status: 200 })).toBe('ok')
    expect(loadOutcome({ ok: true, status: 204 })).toBe('ok')
  })

  /* A 403 is a refusal the screen should report, not a missing record. */
  it('does not treat a refusal as missing', () => {
    expect(loadOutcome({ ok: false, status: 403 })).toBe('error')
    expect(loadOutcome({ ok: false, status: 401 })).toBe('error')
  })
})

describe('createNativeApi', () => {
  it('reads the keychain once, however many requests follow', async () => {
    const chain = keychain('tok_abc')
    const fetched = recorder()
    try {
      const api = createNativeApi(chain.host)
      await api.send('/api/one')
      await api.send('/api/two')
      await api.send('/api/three')

      expect(chain.reads()).toBe(1)
      expect(fetched.calls).toHaveLength(3)
    }
    finally {
      fetched.restore()
    }
  })

  it('replaces a warm screen bearer after a native account switch or sign-out', async () => {
    let session: unknown = {user:{id:1}}
    let token: string | null = 'account-one'
    const api = createNativeApi({snapshots:{get:()=>session},secureStorage:{get:()=>token}})
    const fetched = recorder()
    try {
      await api.send('/api/me')
      session = {user:{id:2}}
      token = 'account-two'
      await api.send('/api/me')
      session = null
      token = null
      await api.send('/api/me')
      expect(fetched.calls.map(call=>call.headers.Authorization)).toEqual(['Bearer account-one','Bearer account-two',undefined])
    }
    finally { fetched.restore() }
  })

  it('refreshes a warm bearer when a password change keeps the same account', async () => {
    let token='old-bearer',version=1
    const api=createNativeApi({snapshots:{get:()=>({user:{id:7},version})},secureStorage:{get:()=>token}})
    const fetched=recorder()
    try {
      await api.send('/api/me')
      token='new-bearer';version++
      await api.send('/api/me')
      expect(fetched.calls.map(call=>call.headers.Authorization)).toEqual(['Bearer old-bearer','Bearer new-bearer'])
    } finally {fetched.restore()}
  })

  it('carries the token on every request', async () => {
    const chain = keychain('tok_abc')
    const fetched = recorder()
    try {
      await createNativeApi(chain.host).send('/api/one')

      expect(fetched.calls[0].url).toBe(`${WILDLOOP_ORIGIN}/api/one`)
      expect(fetched.calls[0].headers.Authorization).toBe('Bearer tok_abc')
    }
    finally {
      fetched.restore()
    }
  })

  it('sends nothing in the authorization header when nobody is signed in', async () => {
    const chain = keychain(null)
    const fetched = recorder()
    try {
      const api = createNativeApi(chain.host)

      expect(await api.readToken()).toBe('')
      await api.send('/api/public')
      expect(fetched.calls[0].headers).not.toHaveProperty('Authorization')
    }
    finally {
      fetched.restore()
    }
  })

  it('serializes a body and declares it', async () => {
    const chain = keychain('tok')
    const fetched = recorder()
    try {
      await createNativeApi(chain.host).send('/api/thing', 'POST', { a: 1 })

      expect(fetched.calls[0].method).toBe('POST')
      expect(fetched.calls[0].body).toBe('{"a":1}')
      expect(fetched.calls[0].headers['Content-Type']).toBe('application/json')
    }
    finally {
      fetched.restore()
    }
  })

  /* A DELETE carries no body, and must not declare one. */
  it('sends a bodyless request without a content type', async () => {
    const chain = keychain('tok')
    const fetched = recorder()
    try {
      await createNativeApi(chain.host).send('/api/thing', 'DELETE')

      expect(fetched.calls[0].body).toBeNull()
      expect(fetched.calls[0].headers).not.toHaveProperty('Content-Type')
    }
    finally {
      fetched.restore()
    }
  })

  /*
   * An error page is text, not JSON. The status is what a screen reads, so a
   * body that will not parse comes back as null rather than throwing.
   */
  it('reads an unparseable body as nothing, rather than throwing', async () => {
    const chain = keychain('tok')
    const fetched = recorder({ status: 500, body: 'not json at all' })
    try {
      const result = await createNativeApi(chain.host).send('/api/thing')

      expect(result).toMatchObject({ ok: false, status: 500, body: null })
    }
    finally {
      fetched.restore()
    }
  })

  /*
   * One cache per screen, as when each screen held its own — two screens in
   * one bundle must not share a token.
   */
  it('gives each screen its own token cache', async () => {
    const chain = keychain('tok')
    const fetched = recorder()
    try {
      await createNativeApi(chain.host).send('/api/one')
      await createNativeApi(chain.host).send('/api/two')

      expect(chain.reads()).toBe(2)
    }
    finally {
      fetched.restore()
    }
  })

  it('reads a keychain value that is not a string as no token', async () => {
    for (const value of [null, undefined, 42, {}]) {
      const chain = keychain(value)
      expect(await createNativeApi(chain.host).readToken()).toBe('')
    }
  })
})

describe('signed-out native mutation security', () => {
  it('gets a Stacks CSRF cookie and echoes the exact token without an authorization header', async () => {
    const previous = globalThis.fetch
    const calls: Array<{url:string, init:any}> = []
    const token = 'b'.repeat(64)
    globalThis.fetch = (async (url:any, init:any) => {
      calls.push({url:String(url),init})
      return String(url).endsWith('/api/csrf')
        ? new Response('{"success":true}', {headers:{'Set-Cookie':`X-CSRF-Token=${token}; Path=/; SameSite=Lax`}})
        : new Response('{"success":true}')
    }) as typeof fetch
    try {
      await createNativeApi(keychain(null).host).send('/api/login','POST',{email:'qa@example.test',password:'test-only'})
      expect(calls.map(call=>call.url)).toEqual([`${WILDLOOP_ORIGIN}/api/csrf`,`${WILDLOOP_ORIGIN}/api/login`])
      expect(calls[1].init.headers).toMatchObject({'X-CSRF-Token':token,Cookie:`X-CSRF-Token=${token}`})
      expect(calls[1].init.headers.Authorization).toBeUndefined()
    } finally { globalThis.fetch=previous }
  })
  it('refuses a mutation when the server does not issue its security cookie', async () => {
    const previous=globalThis.fetch, calls:string[]=[]
    globalThis.fetch=(async(url:any)=>{calls.push(String(url));return new Response('{"success":true}')}) as typeof fetch
    try {
      await expect(createNativeApi(keychain(null).host).send('/api/register','POST',{})).rejects.toThrow('security token could not be loaded')
      expect(calls).toEqual([`${WILDLOOP_ORIGIN}/api/csrf`])
    } finally {globalThis.fetch=previous}
  })
  it('does not submit a guest form if the account changes during its security exchange', async () => {
    const previous=globalThis.fetch, calls:string[]=[]
    let account:any=null
    const host={secureStorage:{get:()=>''},snapshots:{get:()=>account}}
    globalThis.fetch=(async(url:any)=>{calls.push(String(url));account={user:{id:7}};return new Response('{}',{headers:{'Set-Cookie':`X-CSRF-Token=${'c'.repeat(64)}; Path=/`}})}) as typeof fetch
    try {
      await expect(createNativeApi(host).send('/api/login','POST',{})).rejects.toThrow('Your account changed')
      expect(calls).toEqual([`${WILDLOOP_ORIGIN}/api/csrf`])
    } finally {globalThis.fetch=previous}
  })
})

describe('native account-bound operations', () => {
  it('requires a warm screen to reload after its account changes before an operation begins', async () => {
    let account: unknown = {user:{id:7},version:1}
    let token = 'account-seven'
    const fetched = recorder()
    try {
      const api = createNativeApi({snapshots:{get:()=>account},secureStorage:{get:()=>token}})
      await api.send('/api/me')
      account = {user:{id:8},version:2}
      token = 'account-eight'
      await expect(api.bindSession()).rejects.toThrow('Your account changed')
      expect(fetched.calls).toHaveLength(1)
    }
    finally { fetched.restore() }
  })

  it('refuses a warm screen after the bearer changes before the account snapshot arrives', async () => {
    let token = 'account-seven'
    const fetched = recorder()
    try {
      const api = createNativeApi({snapshots:{get:()=>({user:{id:7},version:1})},secureStorage:{get:()=>token}})
      await api.send('/api/me')
      token = 'account-eight'
      await expect(api.bindSession()).rejects.toThrow('Your account changed')
      expect(fetched.calls).toHaveLength(1)
    }
    finally { fetched.restore() }
  })

  it('keeps an identity check and its upload in the same account session', async () => {
    let account: unknown = {user:{id:7},version:1}
    let token = 'account-seven'
    const fetched = recorder({body:'{"user":{"id":7}}'})
    try {
      const api = await createNativeApi({snapshots:{get:()=>account},secureStorage:{get:()=>token}}).bindSession()
      await api.send('/api/me')
      account = {user:{id:8},version:2}
      token = 'account-eight'
      await expect(api.send('/api/activities','POST',{upload_id:'run:owned'})).rejects.toThrow('Your account changed')
      expect(fetched.calls).toHaveLength(1)
      expect(fetched.calls[0].headers.Authorization).toBe('Bearer account-seven')
    }
    finally { fetched.restore() }
  })

  it('works on a cold start without an account snapshot and detects a changed keychain', async () => {
    let token = 'cold-start-token'
    const fetched = recorder()
    try {
      const api = await createNativeApi({secureStorage:{get:()=>token}}).bindSession()
      await api.send('/api/me')
      token = 'replacement-token'
      await expect(api.send('/api/activities','POST',{})).rejects.toThrow('Your account changed')
      expect(fetched.calls).toHaveLength(1)
    }
    finally { fetched.restore() }
  })

  it('does not bind a signed-out session or silently retarget after a keychain read', async () => {
    let account: unknown = {user:{id:7},version:1}
    const fetched = recorder()
    try {
      await expect(createNativeApi({secureStorage:{get:()=>null}}).bindSession()).rejects.toThrow('Sign in')
      const api = createNativeApi({snapshots:{get:()=>account},secureStorage:{get:async()=>{
        account={user:{id:8},version:2}
        return 'previous-token'
      }}})
      await expect(api.bindSession()).rejects.toThrow('Your account changed')
      expect(fetched.calls).toHaveLength(0)
    }
    finally { fetched.restore() }
  })

  it('does not expose an old response after a cold-start bearer changes in flight', async () => {
    let token = 'account-seven'
    const previous = globalThis.fetch
    const bearers: string[] = []
    globalThis.fetch = (async (url: any, init: any) => {
      expect(String(url)).toBe(`${WILDLOOP_ORIGIN}/api/me`)
      bearers.push(init.headers.Authorization)
      token = 'account-eight'
      return new Response('{"user":{"id":7}}')
    }) as typeof fetch
    try {
      const api = await createNativeApi({secureStorage:{get:()=>token}}).bindSession()
      await expect(api.send('/api/me')).rejects.toThrow('Your account changed')
      expect(bearers).toEqual(['Bearer account-seven'])
    }
    finally { globalThis.fetch = previous }
  })
})

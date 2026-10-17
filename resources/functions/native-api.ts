/**
 * The request skeleton every native screen was copying.
 *
 * Twelve screens held the same memoized keychain read and the same
 * token-bearing `fetch`, three of them byte-identical, and the four detail
 * screens added the same 404-versus-failure split on top. Copying it a
 * thirteenth time is how one of the copies quietly stops matching the others.
 *
 * **Native-only.** Unlike the rest of `resources/functions`, this is not
 * shared with the web app: a browser page goes through `apiFetch`, which
 * carries cookies and a CSRF token it has and a native screen does not. The
 * module lives here anyway so `bun run gate:stx` keeps checking it for web
 * APIs — which it has none of, by design. `fetch` is assigned by the runtime
 * and bridged to the Network capability; `JSON` is a language intrinsic.
 *
 * @module functions/native-api
 */

/** Everything a native screen asks for is on the one origin. */
export const WILDLOOP_ORIGIN = 'https://wildloop.org'

export interface NativeResponse {
  ok: boolean
  status: number
  body: any
}

/**
 * The headers a request carries.
 *
 * An anonymous request is a real case rather than an error — the records
 * board and the battle feed both answer without a viewer — so an empty token
 * means no `Authorization` header, not a header with nothing in it.
 */
export function nativeHeaders(token: string, hasBody = false): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (token)
    headers.Authorization = `Bearer ${token}`
  if (hasBody)
    headers['Content-Type'] = 'application/json'
  return headers
}

/**
 * Where a load landed.
 *
 * A record that does not exist is an *answer*, not a failure to load, and the
 * two read differently on screen: "no such territory" against "could not
 * load". 422 joins 404 because the API answers it for an id that is well
 * formed and matches nothing.
 */
export function loadOutcome(response: Pick<NativeResponse, 'ok' | 'status'>): 'ok' | 'missing' | 'error' {
  if (response.status === 404 || response.status === 422)
    return 'missing'
  return response.ok ? 'ok' : 'error'
}

/** The minimum of `craft` this module needs, so a test can stand one up. */
export interface NativeApiHost {
  secureStorage: { get: (key: string) => unknown }
  app?: { url?: string }
  snapshots?: { get: (name: string) => unknown, onChange?: (callback: (name: string) => void) => () => void }
}

/** The configured server, shared by the native app and its simulator builds. */
export function nativeApiOrigin(host: Pick<NativeApiHost, 'app'>): string {
  return /^https?:\/\/[^/?#]+/i.exec(host.app?.url ?? '')?.[0] ?? WILDLOOP_ORIGIN
}

export interface NativeApi {
  /** The stored bearer token, cached only within the current native account session. */
  readToken: () => Promise<string>
  send: (path: string, method?: string, body?: unknown) => Promise<NativeResponse>
  /** Native FormData carries on-device files through Craft's multipart transport. */
  upload: (path: string, form: FormData) => Promise<NativeResponse>
}

/**
 * A token reader and sender bound to one screen.
 *
 * Keychain reads share one promise within the native account snapshot. Login
 * and logout replace that shared snapshot, invalidating warm screens before
 * another request. Hosts without snapshots read the keychain for every request.
 *
 * Called once per screen, so two screens in one bundle do not share a token
 * cache — same as when each screen held its own.
 */
export function createNativeApi(host: NativeApiHost, origin = nativeApiOrigin(host)): NativeApi {
  let reading: Promise<string> | null = null
  let session = ''
  const sessionKey = (): string => host.snapshots ? JSON.stringify(host.snapshots.get('wildloop-session')) ?? 'null' : ''
  const readToken = async (): Promise<string> => {
    const current = sessionKey()
    if (!host.snapshots || session !== current) {
      session = current
      reading = null
    }
    const pending = reading ??= Promise.resolve(host.secureStorage.get('auth_token')).then(value => typeof value === 'string' ? value : '')
    try {
      const token = await pending
      // A keychain request can finish after a sign-out/account switch. Never
      // send the previous account's bearer after the shared session changed.
      if (current !== sessionKey()) return readToken()
      return token
    }
    catch (error) {
      if (reading === pending) reading = null
      throw error
    }
  }

  // Signed-out native forms follow the same Stacks double-submit contract
  // as the browser. Cookie headers are explicit because the Android host and
  // JavaScriptCore expose no document.cookie API or shared browser cookie jar.
  const guestMutationHeaders = async (): Promise<Record<string, string>> => {
    const response = await fetch(`${origin}/api/csrf`, { headers: { Accept: 'application/json' } })
    const cookie = response.headers.get('set-cookie') ?? ''
    const token = /(?:^|,\s*)X-CSRF-Token=([a-f0-9]{64})(?:;|$)/i.exec(cookie)?.[1]
    if (!response.ok || !token) throw new Error('The security token could not be loaded. Please try again.')
    return { 'X-CSRF-Token': token, Cookie: `X-CSRF-Token=${token}` }
  }

  const request = async (path: string, method: string, body: string | FormData | undefined, json: boolean): Promise<NativeResponse> => {
    const account = sessionKey()
    const bearer = await readToken()
    const csrf = !bearer && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) ? await guestMutationHeaders() : {}
    if (account !== sessionKey()) throw new Error('Your account changed. Please try again.')
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: { ...nativeHeaders(bearer, json), ...csrf },
      ...body === undefined ? {} : { body },
    })
    // A body that is not JSON is not an exception — an error page is text, and
    // the status is what the screen reads anyway.
    const payload = await response.json().catch(() => null)
    if (account !== sessionKey()) throw new Error('Your account changed. Please try again.')
    return { ok: response.ok, status: response.status, body: payload }
  }

  return {
    readToken,
    send: (path, method = 'GET', body) => request(path, method, body === undefined ? undefined : JSON.stringify(body), body !== undefined),
    upload: (path, form) => request(path, 'POST', form, false),
  }
}

/** Clear private screen state immediately when a warm tab changes accounts. */
export function onNativeAccountChange(host: NativeApiHost, clear: () => void): () => void {
  const owner = (): number => Number((host.snapshots?.get('wildloop-session') as {user?:{id?:number}} | null)?.user?.id) || 0
  let previous = owner()
  return host.snapshots?.onChange?.((name) => {
    if (name !== 'wildloop-session') return
    const next = owner()
    if (next === previous) return
    previous = next
    clear()
  }) ?? (() => {})
}

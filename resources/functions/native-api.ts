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
}

export interface NativeApi {
  /** The stored bearer token, or '' when nobody is signed in. Read once. */
  readToken: () => Promise<string>
  send: (path: string, method?: string, body?: unknown) => Promise<NativeResponse>
}

/**
 * A token reader and sender bound to one screen.
 *
 * The keychain read is memoized in this closure rather than in a signal: it is
 * a cache and nothing renders from it, which is how all twelve screens used it
 * even though they each spent a `state()` on it.
 *
 * Called once per screen, so two screens in one bundle do not share a token
 * cache — same as when each screen held its own.
 */
export function createNativeApi(host: NativeApiHost, origin = WILDLOOP_ORIGIN): NativeApi {
  let reading: Promise<string> | null = null
  let token = ''

  const readToken = async (): Promise<string> => {
    if (token)
      return token

    reading ??= Promise.resolve(host.secureStorage.get('auth_token')).then((value) => {
      token = typeof value === 'string' ? value : ''
      return token
    })

    return reading
  }

  const send = async (path: string, method = 'GET', body?: unknown): Promise<NativeResponse> => {
    const bearer = await readToken()
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: nativeHeaders(bearer, body !== undefined),
      ...body === undefined ? {} : { body: JSON.stringify(body) },
    })
    // A body that is not JSON is not an exception — an error page is text, and
    // the status is what the screen reads anyway.
    const payload = await response.json().catch(() => null)
    return { ok: response.ok, status: response.status, body: payload }
  }

  return { readToken, send }
}

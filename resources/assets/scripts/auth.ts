/**
 * The browser-side auth client.
 *
 * The sign-in and sign-up pages used to call a bare `auth` global that nothing
 * ever defined, so submitting the form threw a ReferenceError and the page
 * printed `auth is not defined` where the error message goes. Nobody could
 * sign in through the UI at all.
 *
 * This is the missing piece, built on the conventions the rest of the app
 * already uses: the bearer token lives in `auth_token` (shared with
 * `game-api.ts`, so a session started here authenticates activity writes too),
 * and unsafe requests echo the CSRF double-submit cookie the server plants on
 * page loads.
 */

import { describeResponseError, describeThrownError, type UserFacingError } from './request-error'
import { secureStorage } from '@stacksjs/mobile'

/** Where the bearer token lives. `game-api.ts` reads the same key. */
export const TOKEN_KEY = 'auth_token'

/** Where the signed-in user is cached between full page navigations. */
const USER_KEY = 'auth_user'
const SESSION_TOKEN_KEY = 'wildloop_auth_token'
let memoryToken: string | null = null
let sessionInitialization: Promise<void> | null = null

function isCraftHost(): boolean {
  if (typeof globalThis === 'undefined') return false
  const host = globalThis as typeof globalThis & {
    CraftAndroid?: unknown
    craft?: unknown
    webkit?: { messageHandlers?: { craft?: unknown } }
  }
  return Boolean(host.craft || host.CraftAndroid || host.webkit?.messageHandlers?.craft)
}

async function waitForCraftReady(): Promise<void> {
  if (!isCraftHost() || (globalThis as typeof globalThis & { craft?: unknown }).craft) return
  await new Promise<void>((resolve) => {
    const done = () => {
      globalThis.removeEventListener('craftReady', done)
      resolve()
    }
    globalThis.addEventListener('craftReady', done, { once: true })
  })
}

/** Migrate persistent native credentials into Keychain/Keystore once per page. */
export function initializeAuthSession(): Promise<void> {
  if (sessionInitialization) return sessionInitialization
  sessionInitialization = (async () => {
    if (typeof localStorage === 'undefined') return
    if (!isCraftHost()) {
      memoryToken = localStorage.getItem(TOKEN_KEY)
      return
    }
    await waitForCraftReady()
    const legacy = localStorage.getItem(TOKEN_KEY)
    const secured = await secureStorage.get(TOKEN_KEY).catch(() => null)
    memoryToken = secured ?? legacy
    if (legacy && !secured) await secureStorage.set(TOKEN_KEY, legacy)
    localStorage.removeItem(TOKEN_KEY)
    if (memoryToken && typeof sessionStorage !== 'undefined') sessionStorage.setItem(SESSION_TOKEN_KEY, memoryToken)
    globalThis.dispatchEvent(new CustomEvent('wildloop:auth-ready', { detail: { signedIn: Boolean(memoryToken) } }))
  })()
  return sessionInitialization
}

export async function readyToken(): Promise<string | null> {
  await initializeAuthSession()
  return token()
}

export interface AuthUser {
  id: number
  email: string
  name?: string
  avatar?: string | null
  roles?: string[]
}

export interface AuthResult {
  ok: boolean
  user?: AuthUser
  /** Present when `ok` is false. Already safe to render. */
  failure?: UserFacingError
}

/**
 * Read the double-submit CSRF cookie the server sets on safe responses.
 * Returns null off-browser, or before any page load has landed.
 */
export function csrfToken(): string | null {
  if (typeof document === 'undefined')
    return null

  for (const part of document.cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator === -1)
      continue
    if (part.slice(0, separator).trim() !== 'X-CSRF-Token')
      continue
    const value = part.slice(separator + 1).trim()
    return value ? decodeURIComponent(value) : null
  }
  return null
}

function headers(): Record<string, string> {
  const out: Record<string, string> = { 'Content-Type': 'application/json' }
  const csrf = csrfToken()
  if (csrf)
    out['X-CSRF-Token'] = csrf
  return out
}

export function token(): string | null {
  if (memoryToken) return memoryToken
  if (typeof sessionStorage !== 'undefined') {
    const current = sessionStorage.getItem(SESSION_TOKEN_KEY)
    if (current) return current
  }
  return typeof localStorage === 'undefined' ? null : localStorage.getItem(TOKEN_KEY)
}

export function isSignedIn(): boolean {
  return !!token()
}

/** The signed-in user, from the session established at sign-in. */
export function currentUser(): AuthUser | null {
  if (typeof localStorage === 'undefined')
    return null
  const raw = localStorage.getItem(USER_KEY)
  if (!raw)
    return null
  try {
    return JSON.parse(raw) as AuthUser
  }
  catch {
    // A corrupted entry should not wedge every page that checks for a user.
    localStorage.removeItem(USER_KEY)
    return null
  }
}

async function persist(data: { token?: string, user?: AuthUser }): Promise<void> {
  if (typeof localStorage === 'undefined')
    return
  if (data.token) {
    memoryToken = data.token
    if (isCraftHost()) {
      await waitForCraftReady()
      await secureStorage.set(TOKEN_KEY, data.token)
      localStorage.removeItem(TOKEN_KEY)
      if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SESSION_TOKEN_KEY, data.token)
    }
    else {
      localStorage.setItem(TOKEN_KEY, data.token)
    }
  }
  if (data.user)
    localStorage.setItem(USER_KEY, JSON.stringify(data.user))
}

export async function signOut(): Promise<void> {
  if (typeof localStorage === 'undefined')
    return
  memoryToken = null
  if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SESSION_TOKEN_KEY)
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  if (isCraftHost()) await secureStorage.delete(TOKEN_KEY).catch(() => undefined)
}

/**
 * Resolve the bearer token to the authoritative server-side user.
 *
 * Cached identity is only a fast rendering hint. This request is the trust
 * boundary: a revoked or expired token clears both cached values, preventing
 * the UI from continuing to act as a stale/demo athlete.
 */
export async function refreshCurrentUser(): Promise<AuthUser | null> {
  const bearer = token()
  if (!bearer)
    return null

  try {
    const response = await fetch('/api/me', {
      credentials: 'same-origin',
      headers: { Authorization: `Bearer ${bearer}` },
    })

    if (response.status === 401) {
      await signOut()
      return null
    }
    if (!response.ok)
      return currentUser()

    const payload = await response.json().catch(() => null)
    const user = payload?.user as AuthUser | undefined
    if (!user?.id)
      return currentUser()

    await persist({ user })
    return user
  }
  catch {
    // Offline startup may use the last server-verified identity. Writes still
    // require the bearer token and are re-authorized by every endpoint.
    return currentUser()
  }
}

/**
 * POST credentials and normalise every outcome into an `AuthResult`.
 *
 * This never throws. A caller that has to wrap the call in try/catch to avoid
 * showing a raw exception is exactly the shape that produced
 * `auth is not defined`, so the failure is part of the return type instead.
 */
async function submit(path: string, body: Record<string, unknown>, context: string): Promise<AuthResult> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      // The CSRF cookie has to ride along for the double-submit check.
      credentials: 'same-origin',
      headers: headers(),
      body: JSON.stringify(body),
    })

    // A non-JSON body (a proxy's HTML error page, an empty 502) must not throw
    // a SyntaxError that reads as a bug to the person waiting on the form.
    const payload = await response.json().catch(() => null)

    if (!response.ok) {
      const failure = describeResponseError(response.status, payload)
      if (failure.unexpected)
        console.error(`[${context}]`, response.status, failure.cause)
      return { ok: false, failure }
    }

    if (!payload?.token) {
      // A 200 with no token means the contract changed under us. Say something
      // useful and leave the detail in the console.
      console.error(`[${context}] response carried no token`, payload)
      return {
        ok: false,
        failure: { message: 'Something went wrong on our end. Try again in a moment.', unexpected: true, cause: payload },
      }
    }

    await persist({ token: payload.token, user: payload.user })
    return { ok: true, user: payload.user }
  }
  catch (error) {
    const failure = describeThrownError(error)
    if (failure.unexpected)
      console.error(`[${context}]`, failure.cause)
    return { ok: false, failure }
  }
}

/**
 * Land on `path` with the new session applied everywhere.
 *
 * A client-side navigate leaves already-mounted components holding the state
 * they read at init: the nav reads `auth_token` once, so after signing in it
 * still offered "Log in" and "Sign up" until the visitor happened to reload.
 * Signing in is exactly the moment the whole page should agree about who you
 * are, and it happens once per session, so a real navigation is the honest
 * way to get there.
 */
export function redirectAfterAuth(path: string): void {
  redirectTo(path)
}

/**
 * Leave the app for another address.
 *
 * A real navigation, not client-side routing: an OAuth handoff has to put the
 * provider's own domain in the address bar, because that is the only way
 * someone can tell they are approving on Garmin's site and not typing into a
 * convincing copy of it.
 */
export function redirectTo(url: string): void {
  if (typeof location === 'undefined')
    return
  location.assign(url)
}

export function signIn(email: string, password: string): Promise<AuthResult> {
  return submit('/api/login', { email, password }, 'auth:signIn')
}

export function signUp(input: { name: string, email: string, password: string }): Promise<AuthResult> {
  return submit('/api/register', input, 'auth:signUp')
}

/**
 * Where to land after signing in.
 *
 * The sign-in gate (and any link that wants to bring someone back where they
 * were) passes `?redirect=`. Only same-origin paths are honoured: an absolute
 * URL in that parameter would turn every sign-in link into an open redirect,
 * which is the classic way a phishing page borrows a real domain's trust.
 */
export function postAuthDestination(fallback = '/'): string {
  if (typeof location === 'undefined')
    return fallback

  const requested = new URLSearchParams(location.search).get('redirect')
  if (!requested)
    return fallback

  // A single leading slash, and no `//` or `/\` that a browser reads as a host.
  if (!/^\/(?![/\\])/.test(requested))
    return fallback

  return requested
}

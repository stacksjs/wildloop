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
interface PageSession {
  token: string | null
  initialization: Promise<void> | null
  signOutTasks: Set<() => Promise<unknown>>
  /** GETs in flight, so identical ones asked for at once share a request. */
  inflight: Map<string, Promise<Response>>
}

/**
 * Session state for the whole page, not for this module.
 *
 * stx inlines this file into every component bundle that imports it, five
 * copies on the profile page, and each copy kept its own state. Each restored
 * the session by itself: five /api/me calls and five auth-ready events, every
 * one of which made the header refetch notifications. A sign-out run from one
 * copy also never saw the push hook registered with another.
 */
const pageGlobal = globalThis as typeof globalThis & { __wildloopSession?: PageSession }
const session: PageSession = pageGlobal.__wildloopSession ??= {
  token: null,
  initialization: null,
  signOutTasks: new Set(),
  inflight: new Map(),
}

function announceAuthReady(user: AuthUser | null): void {
  if (typeof globalThis.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined')
    return

  globalThis.dispatchEvent(new CustomEvent('wildloop:auth-ready', {
    detail: { signedIn: Boolean(token()), user },
  }))
}

function isCraftHost(): boolean {
  if (typeof globalThis === 'undefined') return false
  const host = globalThis as typeof globalThis & {
    CraftAndroid?: unknown
    craft?: unknown
    webkit?: { messageHandlers?: { craft?: unknown } }
  }
  return Boolean(host.craft || host.CraftAndroid || host.webkit?.messageHandlers?.craft)
}

/**
 * How long to wait for Craft's bridge before carrying on without it. Every
 * authenticated request waits on this, so waiting forever for an event that
 * never comes left the app hanging with no error.
 */
const CRAFT_READY_TIMEOUT_MS = 4000

/** True once Craft's bridge is up; false if it did not come up in time. */
async function waitForCraftReady(): Promise<boolean> {
  if (!isCraftHost() || (globalThis as typeof globalThis & { craft?: unknown }).craft) return true
  return await new Promise<boolean>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      globalThis.removeEventListener('craftReady', done)
      resolve(true)
    }
    const timer = setTimeout(() => {
      globalThis.removeEventListener('craftReady', done)
      resolve(false)
    }, CRAFT_READY_TIMEOUT_MS)
    globalThis.addEventListener('craftReady', done, { once: true })
  })
}

/** Migrate persistent native credentials into Keychain/Keystore once per page. */
export function initializeAuthSession(): Promise<void> {
  if (session.initialization) return session.initialization
  session.initialization = (async () => {
    if (typeof localStorage === 'undefined') return
    if (!isCraftHost()) {
      session.token = localStorage.getItem(TOKEN_KEY)
    }
    else if (!await waitForCraftReady()) {
      // No Keychain yet. Go on with the copy this page session already holds,
      // and restore the full session if the bridge turns up late.
      session.token = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(SESSION_TOKEN_KEY)
      globalThis.addEventListener('craftReady', () => {
        session.initialization = null
        void initializeAuthSession()
      }, { once: true })
    }
    else {
      const legacy = localStorage.getItem(TOKEN_KEY)
      const secured = await secureStorage.get(TOKEN_KEY).catch(() => null)
      // A token in the app's own storage is the newer one: it is only written
      // there when the Keychain refused the last sign-in (see persist).
      session.token = legacy ?? secured
      // Move it into the Keychain, and leave it where it is if the Keychain
      // still will not take it. Removing it regardless is how a failed
      // migration used to lose the only copy.
      if (legacy && (legacy === secured || await saveToKeychain(legacy)))
        localStorage.removeItem(TOKEN_KEY)
      if (session.token && typeof sessionStorage !== 'undefined') sessionStorage.setItem(SESSION_TOKEN_KEY, session.token)
    }

    // A token alone is not enough to render an account menu. Resolve it before
    // announcing the session so every mounted component sees the same identity.
    const user = await refreshCurrentUser()
    announceAuthReady(user)
  })()
  return session.initialization
}

export async function readyToken(): Promise<string | null> {
  await initializeAuthSession()
  return token()
}

function plainHeaders(input: HeadersInit | undefined): Record<string, string> {
  if (!input)
    return {}
  if (typeof Headers !== 'undefined' && input instanceof Headers)
    return Object.fromEntries(input.entries())
  if (Array.isArray(input))
    return Object.fromEntries(input)
  return { ...input as Record<string, string> }
}

/**
 * `fetch` for the Wildloop API.
 *
 * It waits for the session to be restored before sending anything, so the
 * first requests after a cold start no longer go out anonymous, and it sends
 * the bearer token. Every 401 the API answers means there is no valid session
 * (a wrong password at sign-in goes through `submit`, not here), so one ends
 * the session on this device: the page then shows the person signed out
 * instead of letting every later write fail. Only the token the request was
 * sent with is forgotten, never a newer one from a sign-in in the meantime.
 */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const bearer = await readyToken()
  const headers = plainHeaders(init.headers)
  if (bearer && !Object.keys(headers).some(name => name.toLowerCase() === 'authorization'))
    headers.Authorization = `Bearer ${bearer}`

  const method = (init.method ?? 'GET').toUpperCase()
  const response = method === 'GET'
    ? await sharedGet(`${bearer ?? ''} ${path}`, () => fetch(path, { ...init, headers }))
    : await fetch(path, { ...init, headers })
  if (response.status === 401 && bearer && token() === bearer)
    await forgetSession()
  return response
}

/**
 * Identical GETs asked for at the same moment share one request. A page is
 * put together from several bundles that each load what they need, and on a
 * first load they all ask together. Each caller gets its own copy to read.
 */
async function sharedGet(key: string, send: () => Promise<Response>): Promise<Response> {
  let pending = session.inflight.get(key)
  if (!pending) {
    pending = send().finally(() => session.inflight.delete(key))
    session.inflight.set(key, pending)
  }
  return (await pending).clone()
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
  if (session.token) return session.token
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

/**
 * Save the token to the Keychain, and say whether it is really there.
 *
 * Craft resolves a refused Keychain write instead of rejecting it: its
 * `secureStorage.set` drops the native `false`. So a write that did not happen
 * looked like one that did, and on a build whose Keychain refuses every write
 * (the Simulator app, today) each sign-in lasted until the next relaunch.
 * Reading it back is the only answer the bridge gives.
 */
async function saveToKeychain(value: string): Promise<boolean> {
  try {
    await secureStorage.set(TOKEN_KEY, value)
    return await secureStorage.get(TOKEN_KEY) === value
  }
  catch (error) {
    console.error('[auth] could not save the session to the Keychain', error)
    return false
  }
}

async function persist(data: { token?: string, user?: AuthUser }): Promise<void> {
  if (typeof localStorage === 'undefined')
    return
  if (data.token) {
    session.token = data.token
    if (isCraftHost()) {
      if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(SESSION_TOKEN_KEY, data.token)
      if (await waitForCraftReady() && await saveToKeychain(data.token)) {
        localStorage.removeItem(TOKEN_KEY)
      }
      else {
        // No Keychain: keep the token in the app's own storage, which is
        // sandboxed and encrypted at rest, so the sign-in survives a relaunch.
        // Page code can read the Keychain through the bridge anyway, so this
        // gives nothing up against script on the page. Drop any older Keychain
        // copy so a restore cannot pick it over this one.
        localStorage.setItem(TOKEN_KEY, data.token)
        console.warn('[auth] the Keychain refused the session; keeping it in app storage')
        if ((globalThis as typeof globalThis & { craft?: unknown }).craft)
          await secureStorage.delete(TOKEN_KEY).catch(() => undefined)
      }
    }
    else {
      localStorage.setItem(TOKEN_KEY, data.token)
    }
  }
  if (data.user)
    localStorage.setItem(USER_KEY, JSON.stringify(data.user))
}

/** How long sign-out waits on the server before signing out locally anyway. */
const SIGN_OUT_TIMEOUT_MS = 4000

/**
 * Work that has to happen while the session is still valid, run by
 * `signOut` before it revokes the token: unregistering this device from push,
 * for one, which the server only accepts from the signed-in athlete.
 */
export function beforeSignOut(task: () => Promise<unknown>): () => void {
  session.signOutTasks.add(task)
  return () => session.signOutTasks.delete(task)
}

function withTimeout<T>(work: Promise<T>): Promise<T | null> {
  return Promise.race([
    work.catch(() => null),
    new Promise<null>(resolve => setTimeout(() => resolve(null), SIGN_OUT_TIMEOUT_MS)),
  ])
}

/**
 * Sign out: revoke the token on the server, then forget it here.
 *
 * Clearing it locally alone left it valid for up to thirty days, so a copy
 * in a backup or another tab kept working after the person had signed out.
 * The server is asked first but not waited on forever: offline, sign-out
 * still happens on this device.
 */
export async function signOut(): Promise<void> {
  const bearer = token()
  if (bearer) {
    await Promise.all([...session.signOutTasks].map(task => withTimeout(task())))
    await withTimeout(fetch('/api/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { ...headers(), Authorization: `Bearer ${bearer}` },
    }))
  }
  await forgetSession()
}

/**
 * Change the password (PUT /api/me/password).
 *
 * The change ends every session opened before it, this one included, so the
 * server answers with a new token for this device, which replaces the old one
 * here. Other devices are signed out and dropped from push; passing this
 * device's push `deviceId` keeps its own notifications.
 */
export async function changePassword(input: {
  currentPassword: string
  password: string
  confirmation: string
  deviceId?: string | null
}): Promise<{ ok: boolean, message: string }> {
  try {
    const response = await apiFetch('/api/me/password', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: headers(),
      body: JSON.stringify({
        current_password: input.currentPassword,
        password: input.password,
        password_confirmation: input.confirmation,
        ...(input.deviceId ? { device_id: input.deviceId } : {}),
      }),
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok)
      return { ok: false, message: describeResponseError(response.status, payload).message }
    if (typeof payload?.token === 'string' && payload.token)
      await persist({ token: payload.token })
    return { ok: true, message: payload?.message || 'Password changed.' }
  }
  catch (error) {
    return { ok: false, message: describeThrownError(error).message }
  }
}

/** Request a reset without turning an HTTP failure into an inbox confirmation. */
export async function requestPasswordReset(email: string): Promise<{ ok: boolean, message: string }> {
  try {
    const response = await apiFetch('/api/password/forgot', {
      method: 'POST',
      credentials: 'same-origin',
      headers: headers(),
      body: JSON.stringify({ email: email.trim() }),
    })
    if (response.status === 429)
      return { ok: false, message: 'Too many reset attempts. Please try again in a few minutes.' }
    if (!response.ok) {
      const payload = await response.json().catch(() => null)
      return { ok: false, message: describeResponseError(response.status, payload).message }
    }
    // Keep the server's neutral response for both registered and unknown emails.
    return { ok: true, message: '' }
  }
  catch (error) {
    return { ok: false, message: describeThrownError(error).message }
  }
}

/**
 * Delete the signed-in account (DELETE /api/me). Resolves to a message to
 * show, or null once the account is gone and this device has forgotten it.
 *
 * The server asks for the password again, and removes this device's push
 * registration along with the account. The sign-out hooks still run after,
 * signed out by then, so they only clear the device's own opt-in.
 */
export async function deleteAccount(password: string): Promise<string | null> {
  try {
    const response = await apiFetch('/api/me', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: headers(),
      body: JSON.stringify({ password }),
    })
    if (response.ok) {
      await forgetSession()
      await Promise.all([...session.signOutTasks].map(task => withTimeout(task())))
      return null
    }
    const failure = describeResponseError(response.status, await response.json().catch(() => null))
    if (failure.unexpected)
      console.error('[auth:deleteAccount]', response.status, failure.cause)
    return failure.message
  }
  catch (error) {
    return describeThrownError(error).message
  }
}

/** Forget the session on this device only. For a token the server already refused. */
async function forgetSession(): Promise<void> {
  if (typeof localStorage === 'undefined')
    return
  session.token = null
  if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(SESSION_TOKEN_KEY)
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  if (isCraftHost()) await secureStorage.delete(TOKEN_KEY).catch(() => undefined)
  announceAuthReady(null)
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
  if (!bearer) {
    // No token, no session. The cached account is only a rendering hint for
    // a session being checked; without a token it showed a signed-in profile
    // whose every request went out anonymous, and Settings, which checks the
    // token, sent that person to the login page.
    if (typeof localStorage !== 'undefined') localStorage.removeItem(USER_KEY)
    return null
  }

  try {
    const response = await fetch('/api/me', {
      credentials: 'same-origin',
      headers: { Authorization: `Bearer ${bearer}` },
    })

    if (response.status === 401) {
      await forgetSession()
      return null
    }
    if (!response.ok)
      return currentUser()

    const payload = await response.json().catch(() => null)
    // Wildloop wraps this as `{ user }`; the framework default returns the
    // user directly. Supporting both keeps a generated action from turning a
    // valid restored session into an anonymous-looking account menu.
    const user = (payload?.user ?? payload) as AuthUser | undefined
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

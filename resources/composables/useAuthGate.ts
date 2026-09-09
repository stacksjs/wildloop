import { currentUser, initializeAuthSession, isSignedIn, redirectAfterAuth, signIn, signUp, token } from '../assets/scripts/auth'

/**
 * The sign-in gate every "you have to be someone to do this" control shares.
 *
 * Saving a trail, following an athlete and giving kudos all write against the
 * signed-in user. Signed out, the API refused them and the UI did nothing at
 * all — the heart on a trail card was a button that silently ignored you,
 * which reads as a broken page rather than as a wall.
 *
 * So the wall is explicit, and it is the smallest one that works: a modal that
 * signs you in or registers you where you stand, then performs the action you
 * originally asked for. Nobody loses their place in a search to bookmark a
 * trail.
 *
 * ## Why events rather than a shared signal
 *
 * The obvious shape — a module-level `gateOpen` signal that `requireAuth`
 * sets and `<AuthGate />` reads — does not work here. Each stx component gets
 * its own bundle, and a module imported by two of them is INSTANTIATED TWICE:
 * the page's copy of this module and the modal's copy each got their own
 * `state()`, so `requireAuth` opened a modal that nothing was rendering and
 * `<AuthGate />` sat watching a signal nobody ever set.
 *
 * DOM events cross that boundary, because there is only ever one document.
 * `wildloop:auth-required` opens the gate; `wildloop:auth-ready` — the event
 * the native shell already fires when a Keychain session resolves — says a
 * session now exists, and every module instance replays its own queued action
 * when it hears it.
 */

export type AuthGateMode = 'login' | 'register'

/** Fired to open the gate. Detail: `{ reason, mode }`. */
export const AUTH_REQUIRED_EVENT = 'wildloop:auth-required'
/** Fired once a session exists. Detail: `{ signedIn, user }`. */
export const AUTH_READY_EVENT = 'wildloop:auth-ready'

/**
 * The action that was blocked, replayed after a successful sign-in.
 *
 * Per module instance, which is exactly right: the closure belongs to the
 * bundle that created it, and that bundle is the one listening.
 */
let pending: (() => void) | null = null
let listening = false

function replayWhenReady(): void {
  if (listening || typeof globalThis.addEventListener !== 'function')
    return

  listening = true
  globalThis.addEventListener(AUTH_READY_EVENT, () => {
    const action = pending
    pending = null
    // Only replay for a session that actually exists. `auth-ready` also fires
    // when the shell resolves to "signed out", and replaying then would
    // re-open the gate the visitor just dismissed.
    if (action && isSignedIn())
      action()
  })
}

function openGate(reason: string, mode: AuthGateMode): void {
  if (typeof globalThis.dispatchEvent !== 'function')
    return
  globalThis.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT, { detail: { reason, mode } }))
}

/**
 * True when the caller may proceed. When it returns false the gate is open
 * and `action` (if given) runs once the visitor is signed in.
 *
 * Callers read it as a guard:
 *
 *   if (!requireAuth('Save this trail to your list.', () => save(id)))
 *     return
 */
export function requireAuth(reason: string, action?: () => void): boolean {
  if (isSignedIn())
    return true

  pending = action ?? null
  replayWhenReady()
  openGate(reason, 'login')
  return false
}

/** Open the gate directly — used by "Sign up to join" style empty states. */
export function openAuthGate(reason: string, mode: AuthGateMode = 'login'): void {
  pending = null
  openGate(reason, mode)
}

/**
 * Announce the new session.
 *
 * The nav, the store and any follow/save state elsewhere on the page were all
 * rendered for a signed-out visitor, so they are told to re-read rather than
 * left stale — this is the same event the native shell fires when a Keychain
 * session resolves late, and the nav already listens for it.
 */
export async function announceSession(): Promise<void> {
  await initializeAuthSession()
  globalThis.dispatchEvent(new CustomEvent(AUTH_READY_EVENT, {
    detail: { signedIn: Boolean(token()), user: currentUser() },
  }))
}

/** Sign in from inside the gate. Resolves to an error message, or null. */
export async function gateSignIn(email: string, password: string): Promise<string | null> {
  const result = await signIn(email, password)
  if (!result.ok)
    return result.failure?.message ?? 'Could not sign you in. Check your details and try again.'
  await announceSession()
  return null
}

/** Register from inside the gate. Resolves to an error message, or null. */
export async function gateSignUp(name: string, email: string, password: string): Promise<string | null> {
  const result = await signUp({ name, email, password })
  if (!result.ok)
    return result.failure?.message ?? 'Could not create your account. Check your details and try again.'
  await announceSession()
  return null
}

/**
 * Leave for the full page, carrying the visitor back afterwards. The gate is
 * the fast path; someone who needs a password reset or a social provider still
 * has the real screens.
 */
export function goToAuthPage(mode: AuthGateMode): void {
  const here = typeof location === 'undefined' ? '/' : location.pathname + location.search
  redirectAfterAuth(`/${mode}?redirect=${encodeURIComponent(here)}`)
}

/**
 * The app's shortcuts, as iOS surfaces them.
 *
 * Craft's native layer already carries the two pieces this needs — it can set
 * the home-screen quick actions (`window.craft.shortcuts`) and donate a Siri
 * phrase (`window.craft.siri`) — but its TypeScript SDK exports neither, so
 * every caller would otherwise be reaching into `window.craft` and guessing at
 * shapes. This is that seam, in the same shape as the rest of @stacksjs/mobile:
 * typed, safe to call anywhere, and a no-op off a native host.
 *
 * What it does NOT do is decide what the shortcuts are. That list lives in
 * resources/functions/app-shortcuts.ts, with the routes they open.
 */

import type { CraftShortcutItem } from '../functions/app-shortcuts'
import { appShortcutRoute, APP_SHORTCUTS, craftShortcutItems } from '../functions/app-shortcuts'
import { deepLinkPath } from './useNativeServices'

interface CraftShortcutsApi {
  set?: (items: CraftShortcutItem[]) => Promise<unknown>
  clear?: () => Promise<unknown>
  onShortcut?: (handler: (detail: unknown) => void) => void
}

interface CraftSiriApi {
  register?: (phrase: string, action: string) => Promise<unknown>
  remove?: (action: string) => Promise<unknown>
}

interface CraftBridge {
  shortcuts?: CraftShortcutsApi
  siri?: CraftSiriApi
}

function craft(): CraftBridge | null {
  const host = (globalThis as { craft?: CraftBridge }).craft
  return host && typeof host === 'object' ? host : null
}

/**
 * Every one of these bridge calls returns a promise the native side settles.
 *
 * An older build that does not know the message parks the promise forever —
 * Craft's own wrappers keep the callback with no timeout — and these are
 * called from `onMount`, so an unanswered one would hold a mount open for the
 * life of the session. Nothing here is worth waiting on for more than a
 * moment: the shortcuts either registered or they did not.
 */
const BRIDGE_TIMEOUT_MS = 3000

async function settled<T>(work: Promise<T> | undefined, timeoutMs = BRIDGE_TIMEOUT_MS): Promise<T | null> {
  if (!work)
    return null

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      }),
    ])
  }
  catch {
    // A rejected bridge call is a shortcut that did not register, which is
    // the same outcome as a host that has no shortcuts at all.
    return null
  }
  finally {
    if (timer !== undefined)
      clearTimeout(timer)
  }
}

export type ShortcutRegistration = 'registered' | 'unsupported' | 'failed'

/**
 * Offer the app's shortcuts on the home screen.
 *
 * `unsupported` is the ordinary answer on the web and in a native build whose
 * host predates the bridge; only a host that has the call and refused it is a
 * failure.
 */
export async function registerAppShortcuts(): Promise<ShortcutRegistration> {
  // Gated on the call existing rather than on `isNativeMobile()`: what decides
  // whether shortcuts can be offered is whether this host can offer them, and
  // a native build older than the bridge answers that question correctly while
  // a platform check does not.
  const api = craft()?.shortcuts
  if (!api?.set)
    return 'unsupported'

  const result = await settled(api.set(craftShortcutItems()))
  return result === null ? 'failed' : 'registered'
}

/** Take them back down — for a sign-out, where none of them would resolve. */
export async function clearAppShortcuts(): Promise<boolean> {
  const api = craft()?.shortcuts
  if (!api?.clear)
    return false

  return await settled(api.clear()) !== null
}

/**
 * Donate each shortcut's phrase to Siri.
 *
 * This is what puts the app's actions in Siri Suggestions and in Spotlight
 * under the app's name, and it is per-device rather than per-build: the
 * donation has to be repeated, which is why this runs on launch rather than
 * once at install.
 *
 * Returns how many were accepted, so a caller can tell "the host has no Siri"
 * from "Siri refused everything".
 */
export async function donateSiriPhrases(): Promise<number> {
  const api = craft()?.siri
  if (!api?.register)
    return 0

  let donated = 0
  for (const shortcut of APP_SHORTCUTS) {
    if (await settled(api.register(shortcut.phrase, shortcut.id)) !== null)
      donated++
  }
  return donated
}

/**
 * The route a tapped shortcut means.
 *
 * Kept pure and tolerant because the detail's shape is the native side's to
 * choose: Craft's own bridge passes the shortcut item through, and the
 * generated intents open a link instead. Both arrive here, and anything that
 * is neither a known shortcut nor a WildLoop link resolves to null rather than
 * navigating somewhere on a guess.
 */
export function shortcutRoute(detail: unknown): string | null {
  // `deepLinkPath` is the app's one reader of a WildLoop link — the same one
  // the deep-link handler uses — so a shortcut cannot open anywhere a deep
  // link could not, and neither can drift from the other.
  if (typeof detail === 'string')
    return appShortcutRoute(detail) ?? deepLinkPath(detail)

  if (!detail || typeof detail !== 'object')
    return null

  const item = detail as { type?: unknown, url?: unknown, userInfo?: { url?: unknown } }
  const byType = typeof item.type === 'string' ? appShortcutRoute(item.type) : null
  if (byType)
    return byType

  const url = typeof item.userInfo?.url === 'string'
    ? item.userInfo.url
    : typeof item.url === 'string' ? item.url : null

  return url ? deepLinkPath(url) : null
}

/**
 * Follow a shortcut the host reports as tapped.
 *
 * Craft's `onShortcut` listens for a `craftShortcut` event. A host that never
 * sends one simply never calls back, which is why the generated intents open a
 * deep link instead of relying on this: the two paths end at the same routes,
 * and this one costs a listener.
 */
export function onAppShortcut(handler: (route: string) => void): () => void {
  const api = craft()?.shortcuts
  const listener = (event: Event) => {
    const route = shortcutRoute((event as CustomEvent).detail)
    if (route)
      handler(route)
  }

  if (typeof globalThis.addEventListener === 'function')
    globalThis.addEventListener('craftShortcut', listener)

  // Craft's own wrapper offers no way to unsubscribe, so it is registered
  // alongside rather than instead: the listener above is the one this can take
  // back down.
  api?.onShortcut?.((detail) => {
    const route = shortcutRoute(detail)
    if (route)
      handler(route)
  })

  return () => {
    if (typeof globalThis.removeEventListener === 'function')
      globalThis.removeEventListener('craftShortcut', listener)
  }
}

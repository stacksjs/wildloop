/**
 * The app's shortcuts, as iOS surfaces them.
 *
 * Craft's native layer already carries the two pieces this needs — it can set
 * the home-screen quick actions and donate a Siri phrase — and `useCraftBridge`
 * types both. This module is what the app's own shortcuts mean: it registers
 * them, donates them, and reads a tapped one back into a route.
 *
 * What it does NOT do is decide what the shortcuts are. That list lives in
 * resources/functions/app-shortcuts.ts, with the routes they open.
 */

import { appShortcutRoute, APP_SHORTCUTS, craftShortcutItems } from '../functions/app-shortcuts'
import { craftBridge, settled } from './useCraftBridge'
import { deepLinkPath } from './useNativeServices'

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
  const api = craftBridge()?.shortcuts
  if (!api?.set)
    return 'unsupported'

  const result = await settled(api.set(craftShortcutItems()))
  return result === null ? 'failed' : 'registered'
}

/** Take them back down — for a sign-out, where none of them would resolve. */
export async function clearAppShortcuts(): Promise<boolean> {
  const api = craftBridge()?.shortcuts
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
  const api = craftBridge()?.siri
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
 * A reader for an action this module does not own.
 *
 * The app's own shortcuts are a fixed list, but the same Siri/Spotlight
 * channel carries entries other features donate — a trail, say — whose action
 * only they can resolve. Rather than teach this module about them, a caller
 * hands in the reader for its own actions.
 */
export type ActionResolver = (action: string) => string | null

function routeForAction(action: string, resolveAction?: ActionResolver): string | null {
  return appShortcutRoute(action) ?? resolveAction?.(action) ?? null
}

/**
 * The route a tapped shortcut means.
 *
 * Kept pure and tolerant because the detail's shape is the native side's to
 * choose: a home-screen quick action arrives as `{type}`, a Siri or Spotlight
 * entry as `{action, data}`, and the generated intents open a link instead.
 * All three arrive here, and anything that is neither a known action nor a
 * Wildloop link resolves to null rather than navigating somewhere on a guess.
 */
export function shortcutRoute(detail: unknown, resolveAction?: ActionResolver): string | null {
  // `deepLinkPath` is the app's one reader of a Wildloop link — the same one
  // the deep-link handler uses — so a shortcut cannot open anywhere a deep
  // link could not, and neither can drift from the other.
  if (typeof detail === 'string')
    return routeForAction(detail, resolveAction) ?? deepLinkPath(detail)

  if (!detail || typeof detail !== 'object')
    return null

  const item = detail as { type?: unknown, action?: unknown, url?: unknown, userInfo?: { url?: unknown } }

  // An identifier the host chose beats a link it carried: the quick action's
  // `type` and the activity's `action` are both ours, set at donation time,
  // while a url is only ever as trustworthy as `deepLinkPath` finds it.
  for (const key of [item.type, item.action]) {
    const byAction = typeof key === 'string' ? routeForAction(key, resolveAction) : null
    if (byAction)
      return byAction
  }

  const url = typeof item.userInfo?.url === 'string'
    ? item.userInfo.url
    : typeof item.url === 'string' ? item.url : null

  return url ? deepLinkPath(url) : null
}

/** The events a host reports a tapped shortcut on. */
const SHORTCUT_EVENTS = [
  // A home-screen quick action, long-pressed on the icon.
  'craftShortcut',
  // A Siri suggestion, or a Spotlight result for a donated activity.
  'craftSiriShortcut',
] as const

/**
 * Follow a shortcut the host reports as tapped.
 *
 * These are plain window events, listened for directly rather than through
 * Craft's `shortcuts.onShortcut` and `siri.onInvoke`: both of those are
 * themselves listeners on the two events below, so going through them would
 * run every tap twice and leave a subscription their wrappers offer no way to
 * take back down.
 *
 * A host that sends neither event simply never calls back, which is why the
 * generated intents open a deep link instead of relying on this: the two paths
 * end at the same routes, and this one costs a listener.
 */
export function onAppShortcut(handler: (route: string) => void, resolveAction?: ActionResolver): () => void {
  const listener = (event: Event) => {
    const route = shortcutRoute((event as CustomEvent).detail, resolveAction)
    if (route)
      handler(route)
  }

  if (typeof globalThis.addEventListener === 'function') {
    for (const name of SHORTCUT_EVENTS)
      globalThis.addEventListener(name, listener)
  }

  return () => {
    if (typeof globalThis.removeEventListener === 'function') {
      for (const name of SHORTCUT_EVENTS)
        globalThis.removeEventListener(name, listener)
    }
  }
}

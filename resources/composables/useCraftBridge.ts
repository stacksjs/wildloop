/**
 * The one reader of Craft's injected bridge.
 *
 * Craft injects a `window.craft` object into the webview whose TypeScript SDK
 * exports only part of what the native layer actually implements — the
 * shortcut and Siri calls below are both missing from it — so every caller
 * would otherwise be reaching into `window.craft` and guessing at shapes. This
 * is that seam: typed once, safe to call anywhere, and absent on the web.
 *
 * It holds no state and starts nothing. What each call means lives with the
 * feature that uses it.
 */

import type { CraftShortcutItem } from '../functions/app-shortcuts'

export interface CraftShortcutsApi {
  set?: (items: CraftShortcutItem[]) => Promise<unknown>
  clear?: () => Promise<unknown>
  onShortcut?: (handler: (detail: unknown) => void) => void
}

/**
 * Craft's Siri calls, which are also its Spotlight calls.
 *
 * `register` builds an NSUserActivity for the action, marks it eligible for
 * search and prediction, and makes it current — so a registered phrase is both
 * a Siri suggestion and a Spotlight entry — and `remove` deletes the saved
 * activity by that same identifier.
 */
export interface CraftSiriApi {
  register?: (phrase: string, action: string) => Promise<unknown>
  remove?: (action: string) => Promise<unknown>
}

export interface CraftBridge {
  shortcuts?: CraftShortcutsApi
  siri?: CraftSiriApi
}

/** The host's bridge, or null anywhere it is not a native build. */
export function craftBridge(): CraftBridge | null {
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
 * moment: the call either landed or it did not.
 */
export const BRIDGE_TIMEOUT_MS = 3000

export async function settled<T>(work: Promise<T> | undefined, timeoutMs = BRIDGE_TIMEOUT_MS): Promise<T | null> {
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
    // A rejected bridge call is a call that did not land, which is the same
    // outcome as a host that does not have it at all.
    return null
  }
  finally {
    if (timer !== undefined)
      clearTimeout(timer)
  }
}

/**
 * The app's content in the device's search index.
 *
 * AllTrails' trails turn up when you search for them from the home screen,
 * not just the app itself, and that is the difference between an app somebody
 * opens and a trail somebody finds. The same holds for a club or an event.
 *
 * The engine is the framework's — `createSpotlightIndex` assigns each record a
 * slot, remembers which record is in which, evicts the oldest donation when a
 * kind fills up, and reads a tapped action back to a route. What belongs to
 * Wildloop is the registry it runs on (config/spotlight.ts), the storage key,
 * and the calls below, which pages use so no page has to hold the index.
 *
 * On the web, and in a native build whose host predates Craft's Siri bridge,
 * every call here is a no-op that reports as much.
 */

import type { SpotlightItem } from '@stacksjs/mobile'
import { createSpotlightIndex } from '@stacksjs/mobile'
import spotlight from '../../config/spotlight'

const index = createSpotlightIndex({
  kinds: spotlight.kinds,
  enabled: spotlight.enabled,
  storageKey: 'wildloop_spotlight',
  // What the first build of this index stored, when it held nothing but
  // trails. Read once, so the entries iOS is already holding keep answering
  // taps instead of going quiet until each one is donated again.
  legacyStorageKeys: ['wildloop_spotlight_trails'],
})

/**
 * Put a record in the device's index.
 *
 * Called when somebody opens one, and for everything that is theirs: both are
 * a statement that this record matters to them, which is what the index is
 * for.
 */
export function indexInSpotlight(kind: string, item: SpotlightItem): Promise<boolean> {
  return index.index(kind, item)
}

/** Take a record out — it was unsaved, left, withdrawn from, or is gone. */
export function removeFromSpotlight(kind: string, itemId: number): Promise<boolean> {
  return index.remove(kind, itemId)
}

/** Index a whole list of one kind, most important first. */
export function syncSpotlight(kind: string, items: readonly SpotlightItem[]): Promise<number> {
  return index.sync(kind, items)
}

/** Empty the index — for a sign-out, where none of it is this visitor's. */
export function clearSpotlight(): Promise<number> {
  return index.clear()
}

/** The route a tapped Spotlight entry means, for `onAppShortcut`. */
export function spotlightRouteFor(action: string): string | null {
  return index.routeFor(action)
}

/** Forget the cached entries. Tests use this; the app has no reason to. */
export function resetSpotlightCache(): void {
  index.reset()
}

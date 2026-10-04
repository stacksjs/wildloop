/**
 * Trails in iOS Spotlight.
 *
 * AllTrails' trails turn up when you search for them from the home screen,
 * not just the app itself, and that is the difference between an app somebody
 * opens and a trail somebody finds. iOS builds that index out of donated
 * NSUserActivities, which Craft's `siri` bridge is: a title and an action, and
 * what the app gets back on a tap is that action and nothing else.
 *
 * So this is the bookkeeping that makes a tap answerable — which trail is in
 * which of the fixed slots `trail-spotlight.ts` describes, kept in
 * localStorage so it outlives the session the entry was donated in. Every
 * decision about slots lives there; this module only stores, donates, and
 * un-donates.
 *
 * On the web, and in a native build whose host predates the bridge, every call
 * here is a no-op that reports as much.
 */

import type { SpotlightTrail, TrailSpotlightEntry } from '../functions/trail-spotlight'
import {
  placeTrail,
  readSpotlightEntries,
  removeTrail,
  TRAIL_SPOTLIGHT_SLOTS,
  trailSpotlightAction,
  trailSpotlightRoute,
} from '../functions/trail-spotlight'
import { craftBridge, settled } from './useCraftBridge'

const STORAGE_KEY = 'wildloop_spotlight_trails'

/**
 * The entries, also held in memory.
 *
 * A tap is answered synchronously from this, and a native webview can have no
 * localStorage at all (Craft serves the app from `craft://app`), in which case
 * the index still works for the session it was donated in.
 */
let entries: TrailSpotlightEntry[] | null = null

function read(): TrailSpotlightEntry[] {
  if (entries)
    return entries

  entries = []
  if (typeof localStorage === 'undefined')
    return entries

  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    entries = raw ? readSpotlightEntries(JSON.parse(raw)) : []
  }
  catch {
    // Unparseable bookkeeping is an index iOS may still hold entries for, and
    // nothing can be said about them. Donating over the slots is what repairs
    // it, which is what the next indexTrail does.
    entries = []
  }
  return entries
}

function write(next: TrailSpotlightEntry[]): void {
  entries = next
  if (typeof localStorage === 'undefined')
    return

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
  catch {
    // A full or blocked store costs the index its memory across sessions, not
    // this session's entries.
  }
}

/**
 * One bridge call at a time.
 *
 * A trail page donating its own trail while the saved list syncs would
 * otherwise read the same slot assignment twice and donate two trails into one
 * slot — the second silently replacing the first in Spotlight, with the
 * bookkeeping claiming both.
 */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)
  return next
}

/**
 * Put a trail in Spotlight.
 *
 * Called when a trail is opened and for everything the visitor has saved: both
 * are a statement that this trail matters to them, which is what the index is
 * for. Returns false where the host cannot index, or refused.
 */
export async function indexTrail(trail: SpotlightTrail): Promise<boolean> {
  const api = craftBridge()?.siri
  if (!api?.register)
    return false

  return serialize(async () => {
    const placement = placeTrail(read(), trail)
    const action = placement && trailSpotlightAction(placement.entry.slot)
    if (!placement || !action)
      return false

    // Already indexed under this title: iOS holds the right entry, and
    // re-donating it buys nothing. The recency is still worth storing, so the
    // next eviction takes a trail nobody has opened instead of this one.
    if (!placement.changed) {
      write(placement.entries)
      return true
    }

    const accepted = await settled(api.register(placement.entry.title, action)) !== null
    // Stored only once iOS has it, so the bookkeeping never claims an entry
    // that was never donated — a tap on it would resolve to the wrong trail.
    if (accepted)
      write(placement.entries)

    return accepted
  })
}

/**
 * Take a trail out of Spotlight — it was unsaved, or it is gone.
 *
 * The bookkeeping is dropped whether or not iOS confirms the deletion: the
 * visitor asked for this trail to stop being one of theirs, and an entry that
 * resolves to nothing merely opens the app, while one this list still claims
 * would keep opening a trail they removed. Donating into the slot later
 * replaces whatever iOS kept.
 */
export async function unindexTrail(trailId: number): Promise<boolean> {
  const api = craftBridge()?.siri
  if (!api?.remove)
    return false

  return serialize(async () => {
    const { entries: next, removed } = removeTrail(read(), trailId)
    if (!removed)
      return false

    const action = trailSpotlightAction(removed.slot)
    const gone = action ? await settled(api.remove(action)) !== null : false
    write(next)
    return gone
  })
}

/**
 * Index a whole list, most important first.
 *
 * Donated in reverse so the first trail given is the last donated: the most
 * recent donation is the one eviction reaches last, so a saved list longer
 * than the index keeps its head rather than its tail.
 */
export async function syncTrailSpotlight(trails: SpotlightTrail[]): Promise<number> {
  if (!craftBridge()?.siri?.register)
    return 0

  let indexed = 0
  for (const trail of trails.slice(0, TRAIL_SPOTLIGHT_SLOTS).reverse()) {
    if (await indexTrail(trail))
      indexed++
  }
  return indexed
}

/** Empty the index — for a sign-out, where none of it is this visitor's. */
export async function clearTrailSpotlight(): Promise<number> {
  const remove = craftBridge()?.siri?.remove
  if (!remove) {
    write([])
    return 0
  }

  return serialize(async () => {
    let removed = 0
    for (const entry of read()) {
      const action = trailSpotlightAction(entry.slot)
      if (action && await settled(remove(action)) !== null)
        removed++
    }
    write([])
    return removed
  })
}

/**
 * The trail a tapped Spotlight entry means, for `onAppShortcut`.
 *
 * Synchronous, because the tap arrives as an event and the answer is already
 * in memory.
 */
export function trailSpotlightRouteFor(action: string): string | null {
  return trailSpotlightRoute(read(), action)
}

/** Forget the cached entries. Tests use this; the app has no reason to. */
export function resetTrailSpotlightCache(): void {
  entries = null
}

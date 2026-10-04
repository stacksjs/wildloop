/**
 * The app's content in the device's search index.
 *
 * AllTrails' trails turn up when you search for them from the home screen,
 * not just the app itself, and that is the difference between an app somebody
 * opens and a trail somebody finds. The same holds for a club or an event.
 * iOS builds that index out of donated NSUserActivities, which Craft's `siri`
 * bridge is: a title and an action, and what the app gets back on a tap is
 * that action and nothing else.
 *
 * So this is the bookkeeping that makes a tap answerable — which record is in
 * which of the fixed slots `functions/spotlight.ts` describes, kept in
 * localStorage so it outlives the session the entry was donated in. Every
 * decision about slots and routes lives there, and what is indexed at all is
 * config/spotlight.ts; this module only stores, donates, and un-donates.
 *
 * A page calls `indexInSpotlight` for a record somebody opened and
 * `syncSpotlight` for a list that is theirs. On the web, and in a native build
 * whose host predates the bridge, every call here is a no-op that reports as
 * much.
 */

import type { SpotlightEntry, SpotlightItem } from '../functions/spotlight'
import {
  placeItem,
  readSpotlightEntries,
  removeItem,
  SPOTLIGHT_ENABLED,
  spotlightAction,
  spotlightKind,
  spotlightRoute,
} from '../functions/spotlight'
import { craftBridge, settled } from './useCraftBridge'

const STORAGE_KEY = 'wildloop_spotlight'

/**
 * Where the first build of this index stored its entries, when it held
 * nothing but trails.
 *
 * Read once, so the entries iOS is already holding for that build keep
 * answering taps instead of going quiet until each one is donated again.
 */
const LEGACY_STORAGE_KEY = 'wildloop_spotlight_trails'

/**
 * The entries, also held in memory.
 *
 * A tap is answered synchronously from this, and a native webview can have no
 * localStorage at all (Craft serves the app from `craft://app`), in which case
 * the index still works for the session it was donated in.
 */
let entries: SpotlightEntry[] | null = null

function read(): SpotlightEntry[] {
  if (entries)
    return entries

  entries = []
  if (typeof localStorage === 'undefined')
    return entries

  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY)
    entries = raw ? readSpotlightEntries(JSON.parse(raw)) : []
  }
  catch {
    // Unparseable bookkeeping is an index iOS may still hold entries for, and
    // nothing can be said about them. Donating over the slots is what repairs
    // it, which is what the next indexInSpotlight does.
    entries = []
  }
  return entries
}

function write(next: SpotlightEntry[]): void {
  entries = next
  if (typeof localStorage === 'undefined')
    return

  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    localStorage.removeItem(LEGACY_STORAGE_KEY)
  }
  catch {
    // A full or blocked store costs the index its memory across sessions, not
    // this session's entries.
  }
}

/** The host's Siri bridge, which is also its Spotlight bridge. */
function bridge() {
  return SPOTLIGHT_ENABLED ? craftBridge()?.siri : undefined
}

/**
 * One bridge call at a time.
 *
 * A trail page donating its own trail while the saved list syncs would
 * otherwise read the same slot assignment twice and donate two records into
 * one slot — the second silently replacing the first in Spotlight, with the
 * bookkeeping claiming both.
 */
let queue: Promise<unknown> = Promise.resolve()

function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)
  return next
}

/**
 * Put a record in the device's index.
 *
 * Called when somebody opens one, and for everything that is theirs: both are
 * a statement that this record matters to them, which is what the index is
 * for. Returns false where the host cannot index, or refused.
 */
export async function indexInSpotlight(kind: string, item: SpotlightItem): Promise<boolean> {
  const api = bridge()
  if (!api?.register)
    return false

  return serialize(async () => {
    const placement = placeItem(read(), kind, item)
    const action = placement && spotlightAction(kind, placement.entry.slot)
    if (!placement || !action)
      return false

    // Already indexed under this title: iOS holds the right entry, and
    // re-donating it buys nothing. The recency is still worth storing, so the
    // next eviction takes a record nobody has opened instead of this one.
    if (!placement.changed) {
      write(placement.entries)
      return true
    }

    const accepted = await settled(api.register(placement.entry.title, action)) !== null
    // Stored only once iOS has it, so the bookkeeping never claims an entry
    // that was never donated — a tap on it would resolve to the wrong record.
    if (accepted)
      write(placement.entries)

    return accepted
  })
}

/**
 * Take a record out of the index — it was unsaved, left, withdrawn from, gone.
 *
 * The bookkeeping is dropped whether or not iOS confirms the deletion: the
 * visitor asked for this record to stop being one of theirs, and an entry that
 * resolves to nothing merely opens the app, while one this list still claims
 * would keep opening something they removed. Donating into the slot later
 * replaces whatever iOS kept.
 */
export async function removeFromSpotlight(kind: string, itemId: number): Promise<boolean> {
  const remove = bridge()?.remove
  if (!remove)
    return false

  return serialize(async () => {
    const { entries: next, removed } = removeItem(read(), kind, itemId)
    if (!removed)
      return false

    const action = spotlightAction(kind, removed.slot)
    const gone = action ? await settled(remove(action)) !== null : false
    write(next)
    return gone
  })
}

/**
 * Index a whole list of one kind, most important first.
 *
 * Donated in reverse so the first record given is the last donated: the most
 * recent donation is the one eviction reaches last, so a list longer than the
 * kind's budget keeps its head rather than its tail.
 */
export async function syncSpotlight(kind: string, items: SpotlightItem[]): Promise<number> {
  const slots = spotlightKind(kind)?.slots
  if (!slots || !bridge()?.register)
    return 0

  let indexed = 0
  for (const item of items.slice(0, slots).reverse()) {
    if (await indexInSpotlight(kind, item))
      indexed++
  }
  return indexed
}

/** Empty the index — for a sign-out, where none of it is this visitor's. */
export async function clearSpotlight(): Promise<number> {
  const remove = bridge()?.remove
  if (!remove) {
    write([])
    return 0
  }

  return serialize(async () => {
    let removed = 0
    for (const entry of read()) {
      const action = spotlightAction(entry.kind, entry.slot)
      if (action && await settled(remove(action)) !== null)
        removed++
    }
    write([])
    return removed
  })
}

/**
 * The record a tapped Spotlight entry means, for `onAppShortcut`.
 *
 * Synchronous, because the tap arrives as an event and the answer is already
 * in memory.
 */
export function spotlightRouteFor(action: string): string | null {
  return spotlightRoute(read(), action)
}

/** Forget the cached entries. Tests use this; the app has no reason to. */
export function resetSpotlightCache(): void {
  entries = null
}

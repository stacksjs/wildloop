/**
 * Trails, as iOS Spotlight holds them.
 *
 * Craft donates a Spotlight entry by building an NSUserActivity whose type is
 * the app's bundle id plus the action it was given, marking it eligible for
 * search, and making it current. Two consequences shape everything here:
 *
 *   1. iOS only hands a tapped activity back to an app that declares its type
 *      in `NSUserActivityTypes`, and that list is fixed at build time. A type
 *      per trail id would be unbounded, so it cannot be declared — and an
 *      entry iOS will not hand back is worse than no entry, because it opens
 *      the app on whatever screen it was last on.
 *   2. The activity carries no payload of ours: its `userInfo` is just the
 *      action. Whatever a tap needs to know has to be derivable from that.
 *
 * So the app keeps a fixed number of *slots* — `trail-slot-0` and friends, all
 * declared in the generated Info.plist — and each slot holds whichever trail
 * is currently in it. The entries below are that assignment, and because the
 * slot's identifier is also the activity's `persistentIdentifier`, re-donating
 * a slot replaces the entry iOS already has rather than adding another.
 *
 * Everything here is pure: the bookkeeping lives in useTrailSpotlight, which
 * stores these entries and makes the bridge calls.
 */

/**
 * How many trails the app keeps in Spotlight at once.
 *
 * Every one of these is a line in the generated Info.plist, so the number is
 * not free — but it is also the whole index, and somebody who saves thirty
 * trails should not find the first twenty missing. Twenty-four covers a heavy
 * user's saved list with room for what they have been looking at.
 */
export const TRAIL_SPOTLIGHT_SLOTS = 24

/** Spotlight shows one line; past this it is truncated anyway. */
const MAX_TITLE_LENGTH = 120

const ACTION_PREFIX = 'trail-slot-'

export interface TrailSpotlightEntry {
  /** Which slot holds it, and so which action a tap arrives under. */
  slot: number
  trailId: number
  /** What Spotlight shows, kept so a re-donation can be skipped when equal. */
  title: string
  /** When it was last donated, in ms. The oldest is what a full index evicts. */
  donatedAt: number
}

/** What this module needs of a trail — a card row or a detail row both fit. */
export interface SpotlightTrail {
  id: number
  name?: string | null
}

/** The action a slot's entry is donated under, or null for no such slot. */
export function trailSpotlightAction(slot: number): string | null {
  if (!Number.isInteger(slot) || slot < 0 || slot >= TRAIL_SPOTLIGHT_SLOTS)
    return null

  return `${ACTION_PREFIX}${slot}`
}

/**
 * The slot an action names, or null for anything else.
 *
 * Strict about the form — no padding, no trailing text — because this is what
 * decides whether a tap from the system is one of ours.
 */
export function trailSpotlightSlot(action: string): number | null {
  if (typeof action !== 'string' || !action.startsWith(ACTION_PREFIX))
    return null

  const digits = action.slice(ACTION_PREFIX.length)
  if (!/^(?:0|[1-9]\d*)$/.test(digits))
    return null

  const slot = Number(digits)
  return slot < TRAIL_SPOTLIGHT_SLOTS ? slot : null
}

/** Every action the app may donate a trail under, for the Info.plist. */
export function trailSpotlightActions(): string[] {
  return Array.from({ length: TRAIL_SPOTLIGHT_SLOTS }, (_, slot) => `${ACTION_PREFIX}${slot}`)
}

/**
 * What Spotlight shows for a trail.
 *
 * The trail's name alone: Craft hands the same string to Spotlight as the
 * title and to Siri as the invocation phrase, and a name is the one form that
 * reads well in both — "Eagle Peak Loop" is what somebody types looking for
 * it, and what they could say.
 */
export function trailSpotlightTitle(trail: SpotlightTrail): string {
  const name = typeof trail.name === 'string' ? trail.name.replace(/\s+/g, ' ').trim() : ''
  if (!name)
    return `Trail #${trail.id}`

  return name.length > MAX_TITLE_LENGTH ? `${name.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : name
}

/** The result of fitting a trail into the index. */
export interface TrailPlacement {
  entries: TrailSpotlightEntry[]
  /** The slot it now occupies, and the title to donate under it. */
  entry: TrailSpotlightEntry
  /**
   * The trail whose slot this one took, if the index was full.
   *
   * Nothing has to be un-donated for it: the slot's identifier is the
   * activity's, so donating the new entry replaces the old one.
   */
  evicted: TrailSpotlightEntry | null
  /**
   * Whether the entry needs donating at all.
   *
   * False when the same trail already holds a slot under the same title, which
   * is the common case on a second visit — the entry iOS holds is already
   * right, and re-donating it buys nothing.
   */
  changed: boolean
}

/**
 * Put a trail in the index, taking the oldest slot when every one is taken.
 *
 * Returns the whole next list rather than mutating, so the caller stores
 * exactly what it donated — a crash between the two cannot leave bookkeeping
 * that claims an entry iOS does not have.
 */
export function placeTrail(entries: TrailSpotlightEntry[], trail: SpotlightTrail, now = Date.now()): TrailPlacement | null {
  if (!Number.isInteger(trail.id) || trail.id <= 0)
    return null

  const title = trailSpotlightTitle(trail)
  // Already indexed, else a free slot, else the slot of the entry donated
  // longest ago — in that order.
  const held = entries.find(entry => entry.trailId === trail.id) ?? null
  const free = held ? null : firstFreeSlot(entries)
  const evicted = held || free !== null ? null : oldest(entries)
  const slot = held?.slot ?? free ?? evicted?.slot
  if (slot === undefined || slot === null)
    return null

  const entry: TrailSpotlightEntry = { slot, trailId: trail.id, title, donatedAt: now }
  const kept = entries.filter(other => other.slot !== slot && other.trailId !== trail.id)

  return {
    entries: [...kept, entry].sort((a, b) => a.slot - b.slot),
    entry,
    evicted,
    changed: !held || held.title !== title,
  }
}

/** Take a trail out of the index — what it held is the slot to un-donate. */
export function removeTrail(entries: TrailSpotlightEntry[], trailId: number): { entries: TrailSpotlightEntry[], removed: TrailSpotlightEntry | null } {
  const removed = entries.find(entry => entry.trailId === trailId) ?? null
  return {
    entries: removed ? entries.filter(entry => entry.trailId !== trailId) : entries,
    removed,
  }
}

/** The route a tapped entry means, or null for a slot holding nothing. */
export function trailSpotlightRoute(entries: TrailSpotlightEntry[], action: string): string | null {
  const slot = trailSpotlightSlot(action)
  if (slot === null)
    return null

  const entry = entries.find(held => held.slot === slot)
  return entry ? `/trail/${entry.trailId}` : null
}

/**
 * Read back what was stored.
 *
 * Stored state outlives the build that wrote it, and `TRAIL_SPOTLIGHT_SLOTS`
 * can shrink, so anything that is not a slot this build declares is dropped
 * rather than trusted — a tap on it would resolve to a trail the Info.plist no
 * longer lets through.
 */
export function readSpotlightEntries(raw: unknown): TrailSpotlightEntry[] {
  if (!Array.isArray(raw))
    return []

  const bySlot = new Map<number, TrailSpotlightEntry>()
  const seenTrails = new Set<number>()

  for (const item of raw) {
    if (!item || typeof item !== 'object')
      continue

    const { slot, trailId, title, donatedAt } = item as Record<string, unknown>
    if (typeof slot !== 'number' || trailSpotlightAction(slot) === null)
      continue
    if (typeof trailId !== 'number' || !Number.isInteger(trailId) || trailId <= 0)
      continue
    if (bySlot.has(slot) || seenTrails.has(trailId))
      continue

    bySlot.set(slot, {
      slot,
      trailId,
      title: typeof title === 'string' && title.trim() ? title : `Trail #${trailId}`,
      donatedAt: typeof donatedAt === 'number' && Number.isFinite(donatedAt) && donatedAt > 0 ? donatedAt : 0,
    })
    seenTrails.add(trailId)
  }

  return [...bySlot.values()].sort((a, b) => a.slot - b.slot)
}

/** The lowest slot nothing holds, or null once every one is taken. */
function firstFreeSlot(entries: TrailSpotlightEntry[]): number | null {
  const taken = new Set(entries.map(entry => entry.slot))
  for (let slot = 0; slot < TRAIL_SPOTLIGHT_SLOTS; slot++) {
    if (!taken.has(slot))
      return slot
  }
  return null
}

function oldest(entries: TrailSpotlightEntry[]): TrailSpotlightEntry | null {
  return entries.reduce<TrailSpotlightEntry | null>((found, entry) => {
    return !found || entry.donatedAt < found.donatedAt ? entry : found
  }, null)
}

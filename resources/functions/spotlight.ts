/**
 * The app's content, as a device's search index holds it.
 *
 * iOS indexes what the app donates as an `NSUserActivity`, which Craft's
 * `siri` bridge is: a title and an action, and what the app gets back on a tap
 * is that action and nothing else. Two consequences shape everything here:
 *
 *   1. iOS only hands a tapped activity back to an app that declares its type
 *      in `NSUserActivityTypes`, and that list is fixed at build time. A type
 *      per record id would be unbounded, so it cannot be declared — and an
 *      entry iOS will not hand back is worse than no entry, because it opens
 *      the app on whatever screen it was last on.
 *   2. The activity carries no payload of ours. Whatever a tap needs to know
 *      has to be derivable from the action alone.
 *
 * So each kind of content gets a fixed number of *slots* — `trail-slot-0`,
 * `club-slot-0`, all declared in the generated `Info.plist` — and each slot
 * holds whichever record is currently in it. The entries below are that
 * assignment, and because the slot's identifier is also the activity's
 * `persistentIdentifier`, re-donating a slot replaces the entry iOS already
 * has rather than adding another.
 *
 * What is indexed, how many of each, and where a tap opens are config
 * (config/spotlight.ts). Everything here is pure: the storage and the bridge
 * calls live in useSpotlightIndex.
 */

import spotlight from '../../config/spotlight'

/** One kind of content, as the index holds it. */
export interface SpotlightKind {
  /** The name slots are donated under: `trail` gives `trail-slot-0`. */
  name: string
  /** How many of this kind the device holds at once. */
  slots: number
  /** Where a tapped entry opens, with `:id` standing for the record's id. */
  route: string
  /** Names an entry whose record arrived without a name of its own. */
  noun: string
}

/** What this module needs of a record. A card row and a detail row both fit. */
export interface SpotlightItem {
  id: number
  name?: string | null
}

export interface SpotlightEntry {
  /** Which kind's slots this belongs to. */
  kind: string
  /** Which slot holds it, and so which action a tap arrives under. */
  slot: number
  itemId: number
  /** What Spotlight shows, kept so a re-donation can be skipped when equal. */
  title: string
  /** When it was last donated, in ms. The oldest is what a full kind evicts. */
  donatedAt: number
}

/**
 * The most slots one kind may claim.
 *
 * Every slot is a line in the generated `Info.plist` and a possible donation
 * at launch, so a mistyped budget is worth catching here rather than in a
 * build log.
 */
export const MAX_SLOTS_PER_KIND = 64

/** Spotlight shows one line; past this it is truncated anyway. */
const MAX_TITLE_LENGTH = 120

const SLOT_SEPARATOR = '-slot-'
const KIND_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** A kind as configured, or what is wrong with it. */
export interface KindReadResult {
  kinds: SpotlightKind[]
  /** One sentence per entry that was dropped, for a log nobody has to decode. */
  problems: string[]
}

/**
 * Read the configured kinds, dropping any that could not work.
 *
 * Dropping rather than throwing: a typo in one kind's budget should cost that
 * kind's index, not the app's startup. The problems are returned so the caller
 * can say what it ignored — silence here would look like a kind that simply
 * never indexes anything.
 */
export function readSpotlightKinds(raw: unknown): KindReadResult {
  const kinds: SpotlightKind[] = []
  const problems: string[] = []
  const configured = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}

  for (const [name, value] of Object.entries(configured)) {
    const kind = value && typeof value === 'object' ? (value as Record<string, unknown>) : null
    if (!kind) {
      problems.push(`spotlight kind "${name}" is not an object`)
      continue
    }

    const slots = kind.slots
    const route = kind.route
    const noun = typeof kind.noun === 'string' && kind.noun.trim() ? kind.noun.trim() : 'Item'

    if (!KIND_NAME.test(name) || name.includes(SLOT_SEPARATOR)) {
      problems.push(`spotlight kind "${name}" is not a usable name: lowercase letters, digits and single dashes, and never "${SLOT_SEPARATOR}"`)
      continue
    }
    if (typeof slots !== 'number' || !Number.isInteger(slots) || slots <= 0 || slots > MAX_SLOTS_PER_KIND) {
      problems.push(`spotlight kind "${name}" needs slots between 1 and ${MAX_SLOTS_PER_KIND}, not ${String(slots)}`)
      continue
    }
    if (typeof route !== 'string' || !route.startsWith('/') || !route.includes(':id')) {
      problems.push(`spotlight kind "${name}" needs a route starting with "/" and carrying ":id", not ${String(route)}`)
      continue
    }

    kinds.push({ name, slots, route, noun })
  }

  return { kinds, problems }
}

const configured = readSpotlightKinds((spotlight as { kinds?: unknown }).kinds)

// Said once, at import, because a dropped kind is otherwise indistinguishable
// from a kind nothing has donated to yet.
for (const problem of configured.problems)
  console.warn(`[spotlight] ${problem}`)

/** Whether the app may index its content on the device at all. */
export const SPOTLIGHT_ENABLED = (spotlight as { enabled?: unknown }).enabled !== false

/** The kinds this build indexes, in the order they are configured. */
export const SPOTLIGHT_KINDS: SpotlightKind[] = SPOTLIGHT_ENABLED ? configured.kinds : []

/** One kind by name, or null for anything this build does not index. */
export function spotlightKind(name: string): SpotlightKind | null {
  return SPOTLIGHT_KINDS.find(kind => kind.name === name) ?? null
}

/** The action a kind's slot is donated under, or null for no such slot. */
export function spotlightAction(kind: string, slot: number): string | null {
  const configuredKind = spotlightKind(kind)
  if (!configuredKind || !Number.isInteger(slot) || slot < 0 || slot >= configuredKind.slots)
    return null

  return `${kind}${SLOT_SEPARATOR}${slot}`
}

/**
 * The kind and slot an action names, or null for anything else.
 *
 * Strict about the form — no padding, no trailing text, and the kind has to be
 * one this build carries — because this is what decides whether a tap from the
 * system is one of ours.
 */
export function spotlightSlot(action: string): { kind: string, slot: number } | null {
  if (typeof action !== 'string')
    return null

  const at = action.lastIndexOf(SLOT_SEPARATOR)
  if (at <= 0)
    return null

  const kind = action.slice(0, at)
  const digits = action.slice(at + SLOT_SEPARATOR.length)
  if (!/^(?:0|[1-9]\d*)$/.test(digits))
    return null

  const slot = Number(digits)
  return spotlightAction(kind, slot) === action ? { kind, slot } : null
}

/** Every action the app may donate under, for the Info.plist. */
export function spotlightActions(): string[] {
  return SPOTLIGHT_KINDS.flatMap(kind =>
    Array.from({ length: kind.slots }, (_, slot) => `${kind.name}${SLOT_SEPARATOR}${slot}`),
  )
}

/**
 * What Spotlight shows for a record.
 *
 * The record's name alone: Craft hands the same string to Spotlight as the
 * title and to Siri as the invocation phrase, and a name is the one form that
 * reads well in both — "Eagle Peak Loop" is what somebody types looking for
 * it, and what they could say.
 */
export function spotlightTitle(kind: string, item: SpotlightItem): string {
  const name = typeof item.name === 'string' ? item.name.replace(/\s+/g, ' ').trim() : ''
  if (!name)
    return `${spotlightKind(kind)?.noun ?? 'Item'} #${item.id}`

  return name.length > MAX_TITLE_LENGTH ? `${name.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : name
}

/** The result of fitting a record into its kind's slots. */
export interface SpotlightPlacement {
  entries: SpotlightEntry[]
  /** The slot it now occupies, and the title to donate under it. */
  entry: SpotlightEntry
  /**
   * The record whose slot this one took, if the kind was full.
   *
   * Nothing has to be un-donated for it: the slot's identifier is the
   * activity's, so donating the new entry replaces the old one.
   */
  evicted: SpotlightEntry | null
  /**
   * Whether the entry needs donating at all.
   *
   * False when the same record already holds a slot under the same title,
   * which is the common case on a second visit — the entry iOS holds is
   * already right, and re-donating it buys nothing.
   */
  changed: boolean
}

/**
 * Put a record in its kind's slots, taking the oldest when every one is taken.
 *
 * Returns the whole next list rather than mutating, so the caller stores
 * exactly what it donated — a crash between the two cannot leave bookkeeping
 * that claims an entry iOS does not have.
 */
export function placeItem(entries: SpotlightEntry[], kind: string, item: SpotlightItem, now = Date.now()): SpotlightPlacement | null {
  const configuredKind = spotlightKind(kind)
  if (!configuredKind || !Number.isInteger(item.id) || item.id <= 0)
    return null

  const mine = entries.filter(entry => entry.kind === kind)
  const title = spotlightTitle(kind, item)

  // Already indexed, else a free slot, else the slot of the entry donated
  // longest ago — in that order.
  const held = mine.find(entry => entry.itemId === item.id) ?? null
  const free = held ? null : firstFreeSlot(mine, configuredKind.slots)
  const evicted = held || free !== null ? null : oldest(mine)
  const slot = held?.slot ?? free ?? evicted?.slot
  if (slot === undefined || slot === null)
    return null

  const entry: SpotlightEntry = { kind, slot, itemId: item.id, title, donatedAt: now }
  const kept = entries.filter(other => other.kind !== kind || (other.slot !== slot && other.itemId !== item.id))

  return {
    entries: sortEntries([...kept, entry]),
    entry,
    evicted,
    changed: !held || held.title !== title,
  }
}

/** Take a record out — what it held is the slot to un-donate. */
export function removeItem(entries: SpotlightEntry[], kind: string, itemId: number): { entries: SpotlightEntry[], removed: SpotlightEntry | null } {
  const removed = entries.find(entry => entry.kind === kind && entry.itemId === itemId) ?? null
  return {
    entries: removed ? entries.filter(entry => entry !== removed) : entries,
    removed,
  }
}

/** The route a tapped entry means, or null for a slot holding nothing. */
export function spotlightRoute(entries: SpotlightEntry[], action: string): string | null {
  const parsed = spotlightSlot(action)
  if (!parsed)
    return null

  const entry = entries.find(held => held.kind === parsed.kind && held.slot === parsed.slot)
  const route = spotlightKind(parsed.kind)?.route
  return entry && route ? route.replace(':id', String(entry.itemId)) : null
}

/**
 * Read back what was stored.
 *
 * Stored state outlives the build that wrote it — a kind can be renamed, its
 * budget can shrink, and an older build wrote trail entries before kinds
 * existed — so anything that is not a slot this build declares is dropped
 * rather than trusted. A tap on it would resolve to a record the Info.plist no
 * longer lets through.
 */
export function readSpotlightEntries(raw: unknown): SpotlightEntry[] {
  if (!Array.isArray(raw))
    return []

  const bySlot = new Map<string, SpotlightEntry>()
  const seen = new Set<string>()

  for (const item of raw) {
    if (!item || typeof item !== 'object')
      continue

    const record = item as Record<string, unknown>
    // `trailId` is what the first build of this index stored, before it held
    // anything but trails.
    const kind = typeof record.kind === 'string' ? record.kind : typeof record.trailId === 'number' ? 'trail' : ''
    const itemId = typeof record.itemId === 'number' ? record.itemId : record.trailId
    const { slot, title, donatedAt } = record

    if (typeof slot !== 'number' || spotlightAction(kind, slot) === null)
      continue
    if (typeof itemId !== 'number' || !Number.isInteger(itemId) || itemId <= 0)
      continue

    const slotKey = `${kind}${SLOT_SEPARATOR}${slot}`
    const itemKey = `${kind}#${itemId}`
    if (bySlot.has(slotKey) || seen.has(itemKey))
      continue

    bySlot.set(slotKey, {
      kind,
      slot,
      itemId,
      title: typeof title === 'string' && title.trim() ? title : spotlightTitle(kind, { id: itemId }),
      donatedAt: typeof donatedAt === 'number' && Number.isFinite(donatedAt) && donatedAt > 0 ? donatedAt : 0,
    })
    seen.add(itemKey)
  }

  return sortEntries([...bySlot.values()])
}

/** Kinds in configured order, slots ascending — a stable shape to store. */
function sortEntries(entries: SpotlightEntry[]): SpotlightEntry[] {
  const order = new Map(SPOTLIGHT_KINDS.map((kind, index) => [kind.name, index]))
  return [...entries].sort((a, b) =>
    (order.get(a.kind) ?? 0) - (order.get(b.kind) ?? 0) || a.slot - b.slot,
  )
}

/** The lowest slot nothing holds, or null once every one is taken. */
function firstFreeSlot(entries: SpotlightEntry[], slots: number): number | null {
  const taken = new Set(entries.map(entry => entry.slot))
  for (let slot = 0; slot < slots; slot++) {
    if (!taken.has(slot))
      return slot
  }
  return null
}

function oldest(entries: SpotlightEntry[]): SpotlightEntry | null {
  return entries.reduce<SpotlightEntry | null>((found, entry) => {
    return !found || entry.donatedAt < found.donatedAt ? entry : found
  }, null)
}

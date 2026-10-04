import { describe, expect, it } from 'bun:test'
import {
  placeTrail,
  readSpotlightEntries,
  removeTrail,
  TRAIL_SPOTLIGHT_SLOTS,
  trailSpotlightAction,
  trailSpotlightActions,
  trailSpotlightRoute,
  trailSpotlightSlot,
  trailSpotlightTitle,
} from '../../resources/functions/trail-spotlight'
import type { TrailSpotlightEntry } from '../../resources/functions/trail-spotlight'

function entry(slot: number, trailId: number, donatedAt = 1000, title = `Trail #${trailId}`): TrailSpotlightEntry {
  return { slot, trailId, title, donatedAt }
}

/** Fill every slot, oldest first, so the next placement has to evict. */
function fullIndex(): TrailSpotlightEntry[] {
  return Array.from({ length: TRAIL_SPOTLIGHT_SLOTS }, (_, slot) => entry(slot, slot + 1, 1000 + slot))
}

describe('a slot and the action that names it', () => {
  it('names one action per slot, all of them declarable', () => {
    const actions = trailSpotlightActions()
    expect(actions).toHaveLength(TRAIL_SPOTLIGHT_SLOTS)
    expect(new Set(actions).size).toBe(actions.length)
    expect(actions[0]).toBe('trail-slot-0')
    expect(trailSpotlightAction(3)).toBe('trail-slot-3')
  })

  it('has no slot outside the ones the build declares', () => {
    expect(trailSpotlightAction(TRAIL_SPOTLIGHT_SLOTS)).toBeNull()
    expect(trailSpotlightAction(-1)).toBeNull()
    expect(trailSpotlightAction(1.5)).toBeNull()
  })

  it('reads back only the exact form it writes', () => {
    expect(trailSpotlightSlot('trail-slot-0')).toBe(0)
    expect(trailSpotlightSlot('trail-slot-7')).toBe(7)
    expect(trailSpotlightSlot('trail-slot-07')).toBeNull()
    expect(trailSpotlightSlot('trail-slot-')).toBeNull()
    expect(trailSpotlightSlot('trail-slot-1x')).toBeNull()
    expect(trailSpotlightSlot(`trail-slot-${TRAIL_SPOTLIGHT_SLOTS}`)).toBeNull()
    expect(trailSpotlightSlot('favorites')).toBeNull()
  })

  it('round-trips every slot it offers', () => {
    for (const [slot, action] of trailSpotlightActions().entries())
      expect(trailSpotlightSlot(action)).toBe(slot)
  })
})

describe('what Spotlight shows', () => {
  it('is the trail’s name, tidied', () => {
    expect(trailSpotlightTitle({ id: 4, name: '  Eagle Peak   Loop ' })).toBe('Eagle Peak Loop')
  })

  it('falls back to something identifiable rather than an empty row', () => {
    expect(trailSpotlightTitle({ id: 4, name: '   ' })).toBe('Trail #4')
    expect(trailSpotlightTitle({ id: 4, name: null })).toBe('Trail #4')
    expect(trailSpotlightTitle({ id: 4 })).toBe('Trail #4')
  })

  it('does not hand Spotlight a title longer than it shows', () => {
    const title = trailSpotlightTitle({ id: 4, name: 'a'.repeat(400) })
    expect(title.length).toBeLessThanOrEqual(120)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('fitting trails into the index', () => {
  it('takes the lowest free slot', () => {
    const first = placeTrail([], { id: 11, name: 'Ridge Loop' }, 1)!
    expect(first.entry).toEqual({ slot: 0, trailId: 11, title: 'Ridge Loop', donatedAt: 1 })
    expect(first.changed).toBe(true)
    expect(first.evicted).toBeNull()

    const second = placeTrail(first.entries, { id: 12, name: 'Creek Trail' }, 2)!
    expect(second.entry.slot).toBe(1)
    expect(second.entries.map(held => held.trailId)).toEqual([11, 12])
  })

  it('keeps a trail in the slot it already has', () => {
    const first = placeTrail([], { id: 11, name: 'Ridge Loop' }, 1)!
    const again = placeTrail(first.entries, { id: 11, name: 'Ridge Loop' }, 9)!

    expect(again.entry.slot).toBe(0)
    expect(again.entries).toHaveLength(1)
    // Nothing to donate: the entry iOS holds already says this.
    expect(again.changed).toBe(false)
    expect(again.entry.donatedAt).toBe(9)
  })

  it('re-donates a trail whose name changed', () => {
    const first = placeTrail([], { id: 11, name: 'Ridge Loop' }, 1)!
    const renamed = placeTrail(first.entries, { id: 11, name: 'Ridge Loop (closed)' }, 2)!

    expect(renamed.changed).toBe(true)
    expect(renamed.entry.title).toBe('Ridge Loop (closed)')
    expect(renamed.entries).toHaveLength(1)
  })

  it('evicts the entry donated longest ago once every slot is taken', () => {
    const placed = placeTrail(fullIndex(), { id: 999, name: 'New Loop' }, 5000)!

    expect(placed.entry.slot).toBe(0)
    expect(placed.evicted).toEqual(entry(0, 1, 1000))
    expect(placed.entries).toHaveLength(TRAIL_SPOTLIGHT_SLOTS)
    expect(placed.entries.filter(held => held.trailId === 1)).toHaveLength(0)
    // One trail per slot, still.
    expect(new Set(placed.entries.map(held => held.slot)).size).toBe(TRAIL_SPOTLIGHT_SLOTS)
  })

  it('never grows past the slots the build declares', () => {
    let entries: TrailSpotlightEntry[] = []
    for (let id = 1; id <= TRAIL_SPOTLIGHT_SLOTS * 3; id++)
      entries = placeTrail(entries, { id, name: `Trail ${id}` }, id)!.entries

    expect(entries).toHaveLength(TRAIL_SPOTLIGHT_SLOTS)
    expect(new Set(entries.map(held => held.trailId)).size).toBe(TRAIL_SPOTLIGHT_SLOTS)
  })

  it('refuses a trail with no usable id', () => {
    expect(placeTrail([], { id: 0, name: 'Nowhere' })).toBeNull()
    expect(placeTrail([], { id: -3, name: 'Nowhere' })).toBeNull()
    expect(placeTrail([], { id: 1.5, name: 'Nowhere' })).toBeNull()
  })
})

describe('taking a trail out', () => {
  it('reports the slot to un-donate and frees it for the next trail', () => {
    const indexed = placeTrail(placeTrail([], { id: 11, name: 'A' }, 1)!.entries, { id: 12, name: 'B' }, 2)!
    const { entries, removed } = removeTrail(indexed.entries, 11)

    expect(removed?.slot).toBe(0)
    expect(entries.map(held => held.trailId)).toEqual([12])
    expect(placeTrail(entries, { id: 13, name: 'C' }, 3)!.entry.slot).toBe(0)
  })

  it('is a no-op for a trail that was never indexed', () => {
    const indexed = placeTrail([], { id: 11, name: 'A' }, 1)!.entries
    const { entries, removed } = removeTrail(indexed, 404)

    expect(removed).toBeNull()
    expect(entries).toBe(indexed)
  })
})

describe('following a tapped entry', () => {
  it('opens the trail the slot holds', () => {
    const entries = [entry(0, 11), entry(3, 77)]
    expect(trailSpotlightRoute(entries, 'trail-slot-3')).toBe('/trail/77')
  })

  it('opens nothing for a slot holding nothing, or an action that is not ours', () => {
    const entries = [entry(0, 11)]
    expect(trailSpotlightRoute(entries, 'trail-slot-5')).toBeNull()
    expect(trailSpotlightRoute(entries, 'favorites')).toBeNull()
    expect(trailSpotlightRoute(entries, 'trail-slot-nope')).toBeNull()
  })
})

describe('reading back what was stored', () => {
  it('keeps sound entries, in slot order', () => {
    const stored = readSpotlightEntries([entry(3, 77, 20), entry(0, 11, 10)])
    expect(stored.map(held => held.slot)).toEqual([0, 3])
  })

  it('drops a slot this build no longer declares', () => {
    expect(readSpotlightEntries([entry(TRAIL_SPOTLIGHT_SLOTS + 4, 77)])).toEqual([])
  })

  it('drops anything that is not an entry', () => {
    expect(readSpotlightEntries('[]')).toEqual([])
    expect(readSpotlightEntries(null)).toEqual([])
    expect(readSpotlightEntries([null, 7, { slot: 1 }, { trailId: 2 }, { slot: 1, trailId: 0 }])).toEqual([])
  })

  it('keeps one entry per slot and one slot per trail', () => {
    const stored = readSpotlightEntries([entry(1, 11), entry(1, 12), entry(2, 11)])
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ slot: 1, trailId: 11 })
  })

  it('repairs a missing title and a nonsense timestamp rather than dropping the row', () => {
    const stored = readSpotlightEntries([{ slot: 2, trailId: 9, title: '  ', donatedAt: 'soon' }])
    expect(stored[0]).toEqual({ slot: 2, trailId: 9, title: 'Trail #9', donatedAt: 0 })
    // An unknown donation time is the oldest, so a repaired row is evicted first.
    expect(placeTrail(stored, { id: 10, name: 'X' }, 5)!.entry.slot).toBe(0)
  })
})

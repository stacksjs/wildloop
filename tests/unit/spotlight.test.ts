import { describe, expect, it } from 'bun:test'
import type { SpotlightEntry } from '../../resources/functions/spotlight'
import {
  MAX_SLOTS_PER_KIND,
  placeItem,
  readSpotlightEntries,
  readSpotlightKinds,
  removeItem,
  SPOTLIGHT_KINDS,
  spotlightAction,
  spotlightActions,
  spotlightKind,
  spotlightRoute,
  spotlightSlot,
  spotlightTitle,
} from '../../resources/functions/spotlight'

function entry(kind: string, slot: number, itemId: number, donatedAt = 1000, title = `x${itemId}`): SpotlightEntry {
  return { kind, slot, itemId, title, donatedAt }
}

/** Fill one kind's slots, oldest first, so the next placement has to evict. */
function fullKind(kind: string): SpotlightEntry[] {
  const slots = spotlightKind(kind)!.slots
  return Array.from({ length: slots }, (_, slot) => entry(kind, slot, slot + 1, 1000 + slot))
}

describe('the configured kinds', () => {
  it('carries the app’s content types, each with a route a tap can open', () => {
    expect(SPOTLIGHT_KINDS.map(kind => kind.name)).toEqual(['trail', 'club', 'event'])

    for (const kind of SPOTLIGHT_KINDS) {
      expect(kind.slots).toBeGreaterThan(0)
      expect(kind.slots).toBeLessThanOrEqual(MAX_SLOTS_PER_KIND)
      expect(kind.route.startsWith('/')).toBe(true)
      expect(kind.route).toContain(':id')
      expect(kind.noun.length).toBeGreaterThan(0)
    }
  })

  it('does not know a kind nothing configured', () => {
    expect(spotlightKind('mixtape')).toBeNull()
    expect(spotlightAction('mixtape', 0)).toBeNull()
  })
})

describe('reading the configuration', () => {
  it('takes a sound kind as written', () => {
    const { kinds, problems } = readSpotlightKinds({ club: { slots: 8, route: '/club/:id', noun: 'Club' } })

    expect(problems).toEqual([])
    expect(kinds).toEqual([{ name: 'club', slots: 8, route: '/club/:id', noun: 'Club' }])
  })

  it('names what it dropped rather than indexing nothing in silence', () => {
    const { kinds, problems } = readSpotlightKinds({
      'Trail': { slots: 4, route: '/trail/:id' },
      'a-slot-b': { slots: 4, route: '/x/:id' },
      'club': { slots: 0, route: '/club/:id' },
      'event': { slots: MAX_SLOTS_PER_KIND + 1, route: '/event/:id' },
      'route': { slots: 4, route: 'routes/:id' },
      'badge': { slots: 4, route: '/badges' },
      'relic': 'yes',
      'kept': { slots: 2, route: '/kept/:id' },
    })

    expect(kinds.map(kind => kind.name)).toEqual(['kept'])
    expect(problems).toHaveLength(7)
    expect(problems.join('\n')).toContain('"Trail" is not a usable name')
    expect(problems.join('\n')).toContain('"club" needs slots between 1 and')
    expect(problems.join('\n')).toContain('"route" needs a route starting with "/" and carrying ":id"')
    expect(problems.join('\n')).toContain('"relic" is not an object')
  })

  it('falls back to a generic noun rather than dropping a kind over it', () => {
    const { kinds, problems } = readSpotlightKinds({ club: { slots: 1, route: '/club/:id', noun: '  ' } })
    expect(problems).toEqual([])
    expect(kinds[0].noun).toBe('Item')
  })

  it('reads nothing out of nothing', () => {
    expect(readSpotlightKinds(null).kinds).toEqual([])
    expect(readSpotlightKinds('trail').kinds).toEqual([])
  })
})

describe('a slot and the action that names it', () => {
  it('names one action per slot of every kind, all of them declarable', () => {
    const actions = spotlightActions()
    const total = SPOTLIGHT_KINDS.reduce((sum, kind) => sum + kind.slots, 0)

    expect(actions).toHaveLength(total)
    expect(new Set(actions).size).toBe(actions.length)
    expect(actions).toContain('trail-slot-0')
    expect(actions).toContain('club-slot-7')
    expect(actions).toContain('event-slot-0')
  })

  it('round-trips every action it offers', () => {
    for (const action of spotlightActions()) {
      const parsed = spotlightSlot(action)
      expect(parsed).not.toBeNull()
      expect(spotlightAction(parsed!.kind, parsed!.slot)).toBe(action)
    }
  })

  it('reads back only the exact form it writes', () => {
    expect(spotlightSlot('trail-slot-07')).toBeNull()
    expect(spotlightSlot('trail-slot-')).toBeNull()
    expect(spotlightSlot('trail-slot-1x')).toBeNull()
    expect(spotlightSlot('mixtape-slot-0')).toBeNull()
    expect(spotlightSlot('favorites')).toBeNull()
    expect(spotlightSlot(`trail-slot-${spotlightKind('trail')!.slots}`)).toBeNull()
  })
})

describe('what Spotlight shows', () => {
  it('is the record’s name, tidied', () => {
    expect(spotlightTitle('trail', { id: 4, name: '  Eagle Peak   Loop ' })).toBe('Eagle Peak Loop')
  })

  it('falls back to the kind’s own noun rather than an empty row', () => {
    expect(spotlightTitle('trail', { id: 4, name: '  ' })).toBe('Trail #4')
    expect(spotlightTitle('club', { id: 9, name: null })).toBe('Club #9')
    expect(spotlightTitle('event', { id: 2 })).toBe('Event #2')
  })

  it('does not hand Spotlight a title longer than it shows', () => {
    const title = spotlightTitle('trail', { id: 4, name: 'a'.repeat(400) })
    expect(title.length).toBeLessThanOrEqual(120)
    expect(title.endsWith('…')).toBe(true)
  })
})

describe('fitting a record into its kind', () => {
  it('takes the lowest free slot of that kind', () => {
    const first = placeItem([], 'club', { id: 11, name: 'Trail Crew' }, 1)!
    expect(first.entry).toEqual({ kind: 'club', slot: 0, itemId: 11, title: 'Trail Crew', donatedAt: 1 })

    const second = placeItem(first.entries, 'club', { id: 12, name: 'Hill Repeats' }, 2)!
    expect(second.entry.slot).toBe(1)
  })

  it('keeps each kind’s slots to itself', () => {
    const withTrail = placeItem([], 'trail', { id: 7, name: 'Ridge Loop' }, 1)!
    const withClub = placeItem(withTrail.entries, 'club', { id: 7, name: 'Trail Crew' }, 2)!

    // Same slot number, same record id, different kinds: both held.
    expect(withClub.entries).toHaveLength(2)
    expect(withClub.entry.slot).toBe(0)
    expect(spotlightRoute(withClub.entries, 'trail-slot-0')).toBe('/trail/7')
    expect(spotlightRoute(withClub.entries, 'club-slot-0')).toBe('/club/7')
  })

  it('evicts only within the kind that filled up', () => {
    const entries = [...fullKind('club'), entry('trail', 0, 500, 1)]
    const placed = placeItem(entries, 'club', { id: 999, name: 'New Crew' }, 5000)!

    expect(placed.evicted?.kind).toBe('club')
    expect(placed.evicted?.itemId).toBe(1)
    // The trail entry is older than everything, and untouched.
    expect(spotlightRoute(placed.entries, 'trail-slot-0')).toBe('/trail/500')
    expect(placed.entries.filter(held => held.kind === 'club')).toHaveLength(spotlightKind('club')!.slots)
  })

  it('keeps a record in the slot it already has, and re-donates a rename', () => {
    const first = placeItem([], 'event', { id: 3, name: 'Backyard Classic' }, 1)!
    const again = placeItem(first.entries, 'event', { id: 3, name: 'Backyard Classic' }, 9)!
    expect(again.changed).toBe(false)
    expect(again.entry.donatedAt).toBe(9)

    const renamed = placeItem(again.entries, 'event', { id: 3, name: 'Backyard Classic 2027' }, 10)!
    expect(renamed.changed).toBe(true)
    expect(renamed.entries).toHaveLength(1)
  })

  it('refuses a kind it does not carry, or a record with no usable id', () => {
    expect(placeItem([], 'mixtape', { id: 1, name: 'Nope' })).toBeNull()
    expect(placeItem([], 'trail', { id: 0, name: 'Nowhere' })).toBeNull()
    expect(placeItem([], 'trail', { id: -2, name: 'Nowhere' })).toBeNull()
    expect(placeItem([], 'trail', { id: 1.5, name: 'Nowhere' })).toBeNull()
  })
})

describe('taking a record out', () => {
  it('reports the slot to un-donate, and leaves the other kinds alone', () => {
    const entries = [entry('club', 0, 11), entry('trail', 0, 11)]
    const { entries: next, removed } = removeItem(entries, 'club', 11)

    expect(removed).toMatchObject({ kind: 'club', slot: 0 })
    expect(next).toEqual([entry('trail', 0, 11)])
  })

  it('is a no-op for a record that was never indexed', () => {
    const entries = [entry('club', 0, 11)]
    const { entries: next, removed } = removeItem(entries, 'club', 404)

    expect(removed).toBeNull()
    expect(next).toBe(entries)
  })
})

describe('following a tapped entry', () => {
  it('opens the route its kind configures', () => {
    const entries = [entry('event', 2, 77)]
    expect(spotlightRoute(entries, 'event-slot-2')).toBe('/event/77')
  })

  it('opens nothing for an empty slot, or an action that is not ours', () => {
    const entries = [entry('event', 2, 77)]
    expect(spotlightRoute(entries, 'event-slot-3')).toBeNull()
    expect(spotlightRoute(entries, 'mixtape-slot-0')).toBeNull()
    expect(spotlightRoute(entries, 'view-stats')).toBeNull()
  })
})

describe('reading back what was stored', () => {
  it('keeps sound entries, grouped by kind in configured order', () => {
    const stored = readSpotlightEntries([entry('event', 1, 5), entry('trail', 3, 9), entry('club', 0, 2)])
    expect(stored.map(held => held.kind)).toEqual(['trail', 'club', 'event'])
  })

  it('reads what the trails-only build stored, before kinds existed', () => {
    const stored = readSpotlightEntries([{ slot: 2, trailId: 42, title: 'Ridge Loop', donatedAt: 7 }])
    expect(stored).toEqual([{ kind: 'trail', slot: 2, itemId: 42, title: 'Ridge Loop', donatedAt: 7 }])
    expect(spotlightRoute(stored, 'trail-slot-2')).toBe('/trail/42')
  })

  it('drops a kind or a slot this build no longer declares', () => {
    expect(readSpotlightEntries([entry('mixtape', 0, 5)])).toEqual([])
    expect(readSpotlightEntries([entry('club', spotlightKind('club')!.slots + 2, 5)])).toEqual([])
  })

  it('drops anything that is not an entry', () => {
    expect(readSpotlightEntries('[]')).toEqual([])
    expect(readSpotlightEntries(null)).toEqual([])
    expect(readSpotlightEntries([null, 7, { kind: 'trail' }, { slot: 1 }, { kind: 'trail', slot: 1, itemId: 0 }])).toEqual([])
  })

  it('keeps one entry per slot and one slot per record, per kind', () => {
    const stored = readSpotlightEntries([
      entry('club', 1, 11),
      entry('club', 1, 12),
      entry('club', 2, 11),
      entry('trail', 1, 11),
    ])

    expect(stored).toHaveLength(2)
    expect(stored.map(held => `${held.kind}#${held.itemId}`)).toEqual(['trail#11', 'club#11'])
  })

  it('repairs a missing title and a nonsense timestamp rather than dropping the row', () => {
    const stored = readSpotlightEntries([{ kind: 'club', slot: 2, itemId: 9, title: '  ', donatedAt: 'soon' }])
    expect(stored[0]).toEqual({ kind: 'club', slot: 2, itemId: 9, title: 'Club #9', donatedAt: 0 })
    // An unknown donation time is the oldest, so a repaired row is evicted first.
    const full = [...stored, ...fullKind('club').filter(held => held.slot !== 2)]
    expect(placeItem(full, 'club', { id: 10, name: 'X' }, 5)!.entry.slot).toBe(2)
  })
})

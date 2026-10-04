import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  clearSpotlight,
  indexInSpotlight,
  removeFromSpotlight,
  resetSpotlightCache,
  spotlightRouteFor,
  syncSpotlight,
} from '../../resources/composables/useSpotlightIndex'
import { spotlightKind } from '../../resources/functions/spotlight'

const STORAGE_KEY = 'wildloop_spotlight'
const LEGACY_STORAGE_KEY = 'wildloop_spotlight_trails'
const TRAIL_SLOTS = spotlightKind('trail')!.slots

/** The browser surface this module needs: one key in local storage. */
const stored = new Map<string, string>()

function webStorage(map: Map<string, string>) {
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
  }
}

function readStored(): Array<{ kind: string, slot: number, itemId: number }> {
  return JSON.parse(stored.get(STORAGE_KEY) ?? '[]')
}

interface Donation { phrase: string, action: string }

let donated: Donation[]
let removed: string[]

/** Craft's siri bridge, as the webview sees it. */
function installSiri(options: { register?: boolean | 'hang', remove?: boolean } = {}): void {
  const host = globalThis as any
  const register = options.register ?? true
  host.craft = {
    platform: 'ios',
    siri: {
      register: register === false
        ? undefined
        : async (phrase: string, action: string) => {
            donated.push({ phrase, action })
            if (register === 'hang')
              return new Promise(() => {})
            return { registered: true }
          },
      remove: (options.remove ?? true)
        ? async (action: string) => { removed.push(action); return { removed: true } }
        : undefined,
    },
  }
}

beforeEach(() => {
  donated = []
  removed = []
  stored.clear()
  ;(globalThis as any).localStorage = webStorage(stored)
  resetSpotlightCache()
})

afterEach(() => {
  delete (globalThis as any).craft
  delete (globalThis as any).localStorage
  stored.clear()
  resetSpotlightCache()
})

describe('off a host that can index', () => {
  it('does nothing, and says so', async () => {
    expect(await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })).toBe(false)
    expect(await removeFromSpotlight('trail', 7)).toBe(false)
    expect(await syncSpotlight('trail', [{ id: 7, name: 'Ridge Loop' }])).toBe(0)
    expect(stored.has(STORAGE_KEY)).toBe(false)
  })

  it('does nothing on a native build whose host predates the bridge', async () => {
    ;(globalThis as any).craft = { platform: 'ios' }
    expect(await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })).toBe(false)
  })
})

describe('indexing a trail', () => {
  beforeEach(() => installSiri())

  it('donates it under a slot, and remembers which', async () => {
    expect(await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })).toBe(true)

    expect(donated).toEqual([{ phrase: 'Ridge Loop', action: 'trail-slot-0' }])
    expect(spotlightRouteFor('trail-slot-0')).toBe('/trail/7')
    expect(readStored()[0]).toMatchObject({ kind: 'trail', slot: 0, itemId: 7 })
  })

  it('does not donate the same trail twice under the same name', async () => {
    await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })
    expect(await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })).toBe(true)

    expect(donated).toHaveLength(1)
    expect(spotlightRouteFor('trail-slot-0')).toBe('/trail/7')
  })

  it('re-donates a trail that was renamed', async () => {
    await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })
    await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop (closed)' })

    expect(donated.map(entry => entry.phrase)).toEqual(['Ridge Loop', 'Ridge Loop (closed)'])
    expect(donated.every(entry => entry.action === 'trail-slot-0')).toBe(true)
  })

  it('stores nothing the host refused, so a tap cannot resolve to it', async () => {
    ;(globalThis as any).craft = { siri: { register: async () => { throw new Error('Siri is off') } } }

    expect(await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })).toBe(false)
    expect(spotlightRouteFor('trail-slot-0')).toBeNull()
    expect(stored.has(STORAGE_KEY)).toBe(false)
  })

  it('gives up on a bridge call nothing answers', async () => {
    installSiri({ register: 'hang' })
    const started = Date.now()

    expect(await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })).toBe(false)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(spotlightRouteFor('trail-slot-0')).toBeNull()
  }, 10_000)

  it('keeps one trail per slot when two donate at once', async () => {
    await Promise.all([
      indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' }),
      indexInSpotlight('trail', { id: 8, name: 'Creek Trail' }),
    ])

    expect(donated.map(entry => entry.action).sort()).toEqual(['trail-slot-0', 'trail-slot-1'])
    expect(spotlightRouteFor('trail-slot-0')).toBe('/trail/7')
    expect(spotlightRouteFor('trail-slot-1')).toBe('/trail/8')
  })
})

describe('un-indexing a trail', () => {
  beforeEach(() => installSiri())

  it('deletes the entry and frees the slot', async () => {
    await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })
    expect(await removeFromSpotlight('trail', 7)).toBe(true)

    expect(removed).toEqual(['trail-slot-0'])
    expect(spotlightRouteFor('trail-slot-0')).toBeNull()

    await indexInSpotlight('trail', { id: 8, name: 'Creek Trail' })
    expect(spotlightRouteFor('trail-slot-0')).toBe('/trail/8')
  })

  it('is a no-op for a trail that was never indexed', async () => {
    await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })
    expect(await removeFromSpotlight('trail', 404)).toBe(false)
    expect(removed).toEqual([])
    expect(spotlightRouteFor('trail-slot-0')).toBe('/trail/7')
  })

  it('stops claiming a trail even when the deletion was refused', async () => {
    await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })
    ;(globalThis as any).craft = { siri: { remove: async () => { throw new Error('nope') } } }

    expect(await removeFromSpotlight('trail', 7)).toBe(false)
    expect(spotlightRouteFor('trail-slot-0')).toBeNull()
  })
})

describe('syncing a list', () => {
  beforeEach(() => installSiri())

  it('indexes every trail, keeping the head of a list longer than the index', async () => {
    const trails = Array.from({ length: TRAIL_SLOTS + 5 }, (_, i) => ({ id: i + 1, name: `Trail ${i + 1}` }))

    expect(await syncSpotlight('trail', trails)).toBe(TRAIL_SLOTS)

    const indexed = readStored().map(entry => entry.itemId)
    expect(indexed).toHaveLength(TRAIL_SLOTS)
    // The first trail given survives; the ones past the index were never in it.
    expect(indexed).toContain(1)
    expect(indexed).not.toContain(TRAIL_SLOTS + 5)
  })

  it('evicts what nobody has opened when a new trail arrives', async () => {
    const trails = Array.from({ length: TRAIL_SLOTS }, (_, i) => ({ id: i + 1, name: `Trail ${i + 1}` }))
    await syncSpotlight('trail', trails)
    donated = []

    await indexInSpotlight('trail', { id: 999, name: 'New Loop' })

    // The last trail donated by the sync was the first in the list, so the
    // oldest donation — the tail of the list — is what makes room.
    expect(donated).toHaveLength(1)
    const slot = donated[0].action
    expect(spotlightRouteFor(slot)).toBe('/trail/999')
    expect(spotlightRouteFor(`trail-slot-${TRAIL_SLOTS - 1}`)).not.toBe(`/trail/${TRAIL_SLOTS}`)
  })
})

describe('signing out', () => {
  it('takes every entry back down', async () => {
    installSiri()
    await syncSpotlight('trail', [{ id: 7, name: 'A' }, { id: 8, name: 'B' }])

    expect(await clearSpotlight()).toBe(2)
    expect(removed.sort()).toEqual(['trail-slot-0', 'trail-slot-1'])
    expect(spotlightRouteFor('trail-slot-0')).toBeNull()
    expect(readStored()).toEqual([])
  })

  it('forgets the bookkeeping even where it cannot un-donate', async () => {
    installSiri()
    await indexInSpotlight('trail', { id: 7, name: 'A' })
    delete (globalThis as any).craft

    expect(await clearSpotlight()).toBe(0)
    expect(spotlightRouteFor('trail-slot-0')).toBeNull()
  })
})

describe('more than one kind', () => {
  beforeEach(() => installSiri())

  it('keeps each kind in its own slots, and routes a tap to the right one', async () => {
    expect(await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })).toBe(true)
    expect(await indexInSpotlight('club', { id: 7, name: 'Trail Crew' })).toBe(true)
    expect(await indexInSpotlight('event', { id: 9, name: 'Backyard Classic' })).toBe(true)

    expect(donated.map(entry => entry.action)).toEqual(['trail-slot-0', 'club-slot-0', 'event-slot-0'])
    expect(spotlightRouteFor('trail-slot-0')).toBe('/trail/7')
    expect(spotlightRouteFor('club-slot-0')).toBe('/club/7')
    expect(spotlightRouteFor('event-slot-0')).toBe('/event/9')
  })

  it('syncs one kind without disturbing another', async () => {
    await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })
    donated = []

    expect(await syncSpotlight('club', [{ id: 1, name: 'A' }, { id: 2, name: 'B' }])).toBe(2)
    expect(donated.every(entry => entry.action.startsWith('club-slot-'))).toBe(true)
    expect(spotlightRouteFor('trail-slot-0')).toBe('/trail/7')
  })

  it('caps a sync at the kind’s own budget', async () => {
    const clubs = Array.from({ length: spotlightKind('club')!.slots + 4 }, (_, i) => ({ id: i + 1, name: `Club ${i + 1}` }))
    expect(await syncSpotlight('club', clubs)).toBe(spotlightKind('club')!.slots)
    expect(readStored().filter(held => held.kind === 'club')).toHaveLength(spotlightKind('club')!.slots)
  })

  it('does nothing for a kind nothing configured', async () => {
    expect(await indexInSpotlight('mixtape', { id: 1, name: 'Nope' })).toBe(false)
    expect(await syncSpotlight('mixtape', [{ id: 1, name: 'Nope' }])).toBe(0)
    expect(donated).toEqual([])
  })

  it('clears every kind at once on sign-out', async () => {
    await indexInSpotlight('trail', { id: 7, name: 'A' })
    await indexInSpotlight('club', { id: 8, name: 'B' })

    expect(await clearSpotlight()).toBe(2)
    expect(removed.sort()).toEqual(['club-slot-0', 'trail-slot-0'])
    expect(spotlightRouteFor('club-slot-0')).toBeNull()
  })
})

describe('what a previous session left', () => {
  it('answers a tap from storage, without re-donating anything', () => {
    stored.set(STORAGE_KEY, JSON.stringify([{ slot: 2, trailId: 42, title: 'Ridge Loop', donatedAt: 1 }]))
    resetSpotlightCache()

    expect(spotlightRouteFor('trail-slot-2')).toBe('/trail/42')
    expect(donated).toEqual([])
  })

  it('still answers taps on entries the trails-only build donated', async () => {
    // Its key, its shape: {slot, trailId}. iOS is already holding these.
    stored.set(LEGACY_STORAGE_KEY, JSON.stringify([{ slot: 1, trailId: 42, title: 'Ridge Loop', donatedAt: 5 }]))
    resetSpotlightCache()

    expect(spotlightRouteFor('trail-slot-1')).toBe('/trail/42')

    // And once anything is written, the entries move to the current key.
    installSiri()
    await indexInSpotlight('club', { id: 3, name: 'Trail Crew' })
    expect(readStored().map(held => `${held.kind}#${held.itemId}`)).toEqual(['trail#42', 'club#3'])
    expect(stored.has(LEGACY_STORAGE_KEY)).toBe(false)
  })

  it('answers nothing for bookkeeping it cannot read', () => {
    stored.set(STORAGE_KEY, 'not json')
    resetSpotlightCache()

    expect(spotlightRouteFor('trail-slot-0')).toBeNull()
  })
})

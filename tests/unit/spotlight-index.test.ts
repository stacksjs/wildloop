import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readSpotlightKinds } from '@stacksjs/mobile'
import spotlightConfig from '../../config/spotlight'
import {
  clearSpotlight,
  indexInSpotlight,
  removeFromSpotlight,
  resetSpotlightCache,
  spotlightRouteFor,
  syncSpotlight,
} from '../../resources/composables/useSpotlightIndex'
import { deepLinkPath } from '../../resources/composables/useNativeServices'

/**
 * The app's side of the device index: the registry it runs on, and the calls
 * pages make. The slot arithmetic, the eviction order and the storage format
 * are the framework's, and tested there (@stacksjs/mobile).
 */

const STORAGE_KEY = 'wildloop_spotlight'
const LEGACY_STORAGE_KEY = 'wildloop_spotlight_trails'

const KINDS = readSpotlightKinds(spotlightConfig.kinds).kinds
const TRAIL_SLOTS = KINDS.find(kind => kind.name === 'trail')!.slots
const CLUB_SLOTS = KINDS.find(kind => kind.name === 'club')!.slots

interface Donation { phrase: string, action: string }

let donated: Donation[]
let removed: string[]
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

/** Craft's injected Siri bridge, as the webview sees it. */
function installSiri(): void {
  ;(globalThis as any).craft = {
    platform: 'ios',
    siri: {
      register: async (phrase: string, action: string) => { donated.push({ phrase, action }); return { registered: true } },
      remove: async (action: string) => { removed.push(action); return { removed: true } },
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

describe('the registry this app configures', () => {
  it('carries the content the product has pages for', () => {
    expect(KINDS.map(kind => kind.name)).toEqual(['trail', 'club', 'event'])
    expect(readSpotlightKinds(spotlightConfig.kinds).problems).toEqual([])
  })

  it('gives trails the largest budget, since the saved list is the longest', () => {
    expect(TRAIL_SLOTS).toBeGreaterThan(CLUB_SLOTS)
  })

  it('opens every kind at a route this app can actually route', () => {
    for (const kind of KINDS) {
      const route = kind.route.replace(':id', '42')
      // The app's one reader of a link, the same one deep links take.
      expect(deepLinkPath(`wildloop://${route.replace(/^\//, '')}`)).toBe(route)
    }
  })
})

describe('off a host that can index', () => {
  it('does nothing, and says so', async () => {
    expect(await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })).toBe(false)
    expect(await removeFromSpotlight('trail', 7)).toBe(false)
    expect(await syncSpotlight('trail', [{ id: 7, name: 'Ridge Loop' }])).toBe(0)
    expect(stored.has(STORAGE_KEY)).toBe(false)
  })
})

describe('on a phone', () => {
  beforeEach(() => installSiri())

  it('donates a record under its kind, and answers the tap', async () => {
    expect(await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })).toBe(true)
    expect(await indexInSpotlight('club', { id: 7, name: 'Trail Crew' })).toBe(true)
    expect(await indexInSpotlight('event', { id: 9, name: 'Backyard Classic' })).toBe(true)

    expect(donated.map(one => one.action)).toEqual(['trail-slot-0', 'club-slot-0', 'event-slot-0'])
    expect(spotlightRouteFor('trail-slot-0')).toBe('/trail/7')
    expect(spotlightRouteFor('club-slot-0')).toBe('/club/7')
    expect(spotlightRouteFor('event-slot-0')).toBe('/event/9')
  })

  it('stores the assignment under this app’s own key', async () => {
    await indexInSpotlight('trail', { id: 7, name: 'Ridge Loop' })
    expect(readStored()[0]).toMatchObject({ kind: 'trail', slot: 0, itemId: 7 })
  })

  it('keeps the head of a saved list longer than its budget', async () => {
    const trails = Array.from({ length: TRAIL_SLOTS + 5 }, (_, i) => ({ id: i + 1, name: `Trail ${i + 1}` }))
    expect(await syncSpotlight('trail', trails)).toBe(TRAIL_SLOTS)

    const indexed = readStored().map(entry => entry.itemId)
    expect(indexed).toContain(1)
    expect(indexed).not.toContain(TRAIL_SLOTS + 5)
  })

  it('takes a record out when it stops being theirs', async () => {
    await indexInSpotlight('club', { id: 7, name: 'Trail Crew' })
    expect(await removeFromSpotlight('club', 7)).toBe(true)

    expect(removed).toEqual(['club-slot-0'])
    expect(spotlightRouteFor('club-slot-0')).toBeNull()
  })

  it('empties every kind on sign-out', async () => {
    await indexInSpotlight('trail', { id: 7, name: 'A' })
    await indexInSpotlight('club', { id: 8, name: 'B' })

    expect(await clearSpotlight()).toBe(2)
    expect(removed.sort()).toEqual(['club-slot-0', 'trail-slot-0'])
    expect(spotlightRouteFor('trail-slot-0')).toBeNull()
  })

  it('still answers taps on entries the trails-only build donated', async () => {
    stored.set(LEGACY_STORAGE_KEY, JSON.stringify([{ kind: 'trail', slot: 1, itemId: 42, title: 'Ridge Loop', donatedAt: 5 }]))
    resetSpotlightCache()

    expect(spotlightRouteFor('trail-slot-1')).toBe('/trail/42')

    // And once anything is written, the entries move to the current key.
    await indexInSpotlight('club', { id: 3, name: 'Trail Crew' })
    expect(stored.has(LEGACY_STORAGE_KEY)).toBe(false)
    expect(readStored().map(entry => `${entry.kind}#${entry.itemId}`)).toEqual(['trail#42', 'club#3'])
  })

  it('does nothing for a kind this app does not configure', async () => {
    expect(await indexInSpotlight('mixtape', { id: 1, name: 'Nope' })).toBe(false)
    expect(donated).toEqual([])
  })
})

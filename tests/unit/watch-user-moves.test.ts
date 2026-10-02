import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { watchUserMoves } from '../../resources/composables/useTrailMap'

/**
 * Whose move was it?
 *
 * "Search this area" is offered when the person moves the map and withheld
 * when the page fits it to its own results, and the map reports both the same
 * way. The distinction is drawn from when the move *began*, which is why a
 * move that takes a long time to finish is still theirs.
 */

/** Enough of a map for the watcher: a container to listen on, and events. */
function fakeMap() {
  const container = new EventTarget()
  const handlers = new Map<string, Set<() => void>>()
  return {
    map: {
      getContainer: () => container,
      on(event: string, handler: () => void) {
        let set = handlers.get(event)
        if (!set)
          handlers.set(event, set = new Set())
        set.add(handler)
      },
      off(event: string, handler: () => void) {
        handlers.get(event)?.delete(handler)
      },
    },
    emit(event: string) {
      for (const handler of [...handlers.get(event) ?? []])
        handler()
    },
    press() {
      container.dispatchEvent(new Event('pointerdown'))
    },
    bound: () => [...handlers.values()].reduce((total, set) => total + set.size, 0),
  }
}

const realNow = Date.now
let now = 1_700_000_000_000

function advance(ms: number): void {
  now += ms
}

beforeEach(() => {
  now = 1_700_000_000_000
  Date.now = () => now
})

afterEach(() => {
  Date.now = realNow
})

/** The stub is a map as far as the watcher is concerned, not as far as types are. */
function watch(fake: ReturnType<typeof fakeMap>, onMoved: () => void): () => void {
  return watchUserMoves(fake.map as unknown as Parameters<typeof watchUserMoves>[0], onMoved)
}

describe('watchUserMoves', () => {
  it('counts a zoom whose animation took seconds to settle', () => {
    const fake = fakeMap()
    let moved = 0
    const stop = watch(fake, () => moved++)

    fake.press()
    fake.emit('movestart')
    // A loaded machine: the press was prompt, the animation that ends the move
    // was not. Nine seconds is past any grace the press could have bought.
    advance(9000)
    fake.emit('moveend')
    stop()

    // Theirs. It was theirs when it started, and taking a long time does not
    // hand it to us.
    expect(moved).toBe(1)
  })

  it('withholds the move the page made to fit its own results', () => {
    const fake = fakeMap()
    let moved = 0
    const stop = watch(fake, () => moved++)

    fake.emit('movestart')
    fake.emit('moveend')
    stop()

    expect(moved).toBe(0)
  })

  it('withholds a move that began long after the last thing they touched', () => {
    const fake = fakeMap()
    let moved = 0
    const stop = watch(fake, () => moved++)

    fake.press()
    // Past the grace: whatever started moving now, they did not start it.
    advance(2000)
    fake.emit('movestart')
    fake.emit('moveend')
    stop()

    expect(moved).toBe(0)
  })

  it('counts a drag, which moves the map for as long as they hold it', () => {
    const fake = fakeMap()
    let moved = 0
    const stop = watch(fake, () => moved++)

    fake.emit('dragstart')
    fake.emit('movestart')
    advance(4000)
    fake.emit('dragend')
    fake.emit('moveend')
    stop()

    expect(moved).toBe(1)
  })

  it('counts a move that never announced its start', () => {
    const fake = fakeMap()
    let moved = 0
    const stop = watch(fake, () => moved++)

    // No `movestart` to judge: the press it followed is the only evidence.
    fake.press()
    fake.emit('moveend')
    stop()

    expect(moved).toBe(1)
  })

  it('counts each move once, not once per start it saw', () => {
    const fake = fakeMap()
    let moved = 0
    const stop = watch(fake, () => moved++)

    // A zoom announces both; one move happened.
    fake.press()
    fake.emit('movestart')
    fake.emit('zoomstart')
    advance(3000)
    fake.emit('moveend')
    stop()

    expect(moved).toBe(1)
  })

  it('lets go of every listener when stopped', () => {
    const fake = fakeMap()
    let moved = 0
    const stop = watch(fake, () => moved++)
    expect(fake.bound()).toBeGreaterThan(0)

    stop()
    fake.press()
    fake.emit('movestart')
    fake.emit('moveend')

    expect(fake.bound()).toBe(0)
    expect(moved).toBe(0)
  })
})

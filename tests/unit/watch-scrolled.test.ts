import { afterEach, describe, expect, it } from 'bun:test'
import { watchScrolled } from '../../resources/composables/watchScrolled'

const originalScrollY = Object.getOwnPropertyDescriptor(globalThis, 'scrollY')

function scrollTo(y: number): void {
  Object.defineProperty(globalThis, 'scrollY', { value: y, configurable: true, writable: true })
  globalThis.dispatchEvent(new Event('scroll'))
}

afterEach(() => {
  if (originalScrollY)
    Object.defineProperty(globalThis, 'scrollY', originalScrollY)
  else
    delete (globalThis as { scrollY?: number }).scrollY
})

describe('watchScrolled', () => {
  it('reports the starting position straight away', () => {
    Object.defineProperty(globalThis, 'scrollY', { value: 400, configurable: true, writable: true })
    const seen: boolean[] = []
    const stop = watchScrolled(value => seen.push(value))
    stop()

    // A reload that restores a scroll position must not start in the top state.
    expect(seen).toEqual([true])
  })

  it('follows the page down and back up, once per change', () => {
    scrollTo(0)
    const seen: boolean[] = []
    const stop = watchScrolled(value => seen.push(value))

    scrollTo(3)
    scrollTo(120)
    scrollTo(900)
    scrollTo(0)
    stop()

    // Within the tolerance is still the top; the repeated scroll events in
    // between report nothing new.
    expect(seen).toEqual([false, true, false])
  })

  it('stops listening once stopped', () => {
    scrollTo(0)
    const seen: boolean[] = []
    const stop = watchScrolled(value => seen.push(value))
    stop()
    scrollTo(900)

    expect(seen).toEqual([false])
  })
})

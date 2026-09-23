import { onDestroy, onMount, state } from 'stx'

/**
 * Whether the page has been scrolled away from the very top.
 *
 * A few pixels of tolerance, because elastic scrolling on macOS reports
 * fractional and negative offsets while it settles, and a threshold of exactly
 * zero makes anything bound to this flicker at the top of the page.
 *
 * Returned as a local signal so a template reads it directly — stx templates
 * only evaluate their own declarations.
 */
export function useScrolled(threshold = 8) {
  const scrolled = state(false)

  function update() {
    scrolled.set((globalThis.scrollY || 0) > threshold)
  }

  onMount(() => {
    update()
    globalThis.addEventListener('scroll', update, { passive: true })
  })

  onDestroy(() => {
    globalThis.removeEventListener('scroll', update)
  })

  return { scrolled }
}

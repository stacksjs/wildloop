/**
 * Report whether the page is scrolled away from the very top, now and on every
 * change. Returns the function that stops listening.
 *
 * Deliberately not a composable with its own `onMount`. Imported modules are
 * bundled into the page's module registry, where `onMount` is the global one,
 * and a component in the layout (the nav) is set up with its own scoped
 * `onMount` instead: a callback handed to the global one from there never
 * runs, so the listener was never attached and the bar stayed in its
 * top-of-page state all the way down. The caller wires this into its own
 * lifecycle.
 *
 * A few pixels of tolerance, because elastic scrolling on macOS reports
 * fractional and negative offsets while it settles, and a threshold of exactly
 * zero makes anything bound to this flicker at the top of the page.
 */
export function watchScrolled(onChange: (scrolled: boolean) => void, threshold = 8): () => void {
  let last: boolean | null = null

  function update(): void {
    const scrolled = (globalThis.scrollY || 0) > threshold
    if (scrolled === last)
      return
    last = scrolled
    onChange(scrolled)
  }

  update()
  globalThis.addEventListener('scroll', update, { passive: true })
  return () => globalThis.removeEventListener('scroll', update)
}

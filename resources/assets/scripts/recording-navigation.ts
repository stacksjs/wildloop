const RECORDING_EXIT_EVENT = 'wildloop:before-recording-exit'

/** App actions such as logout must ask before changing identity or route. */
export function requestRecordingExit(): boolean {
  if (typeof globalThis.dispatchEvent !== 'function' || typeof CustomEvent === 'undefined') return true
  return globalThis.dispatchEvent(new CustomEvent(RECORDING_EXIT_EVENT, { cancelable: true }))
}

/** Keep app navigation from silently destroying a page-owned GPS recording. */
export function installRecordingNavigationGuard(isProtected: () => boolean, onBlocked: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const recordingURL = location.href
  const recordingHistoryState = history.state
  const exit = (event: Event) => {
    if (!isProtected()) return
    event.preventDefault()
    onBlocked()
  }
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!isProtected()) return
    event.preventDefault()
    event.returnValue = ''
  }
  const click = (event: MouseEvent) => {
    if (!isProtected() || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return
    const destination = new URL(anchor.href, location.href)
    if (!['http:', 'https:'].includes(destination.protocol)) return
    if (destination.origin === location.origin && destination.pathname === location.pathname && destination.search === location.search) return
    event.preventDefault()
    event.stopImmediatePropagation()
    onBlocked()
  }
  const popstate = (event: PopStateEvent) => {
    if (!isProtected()) return
    // popstate cannot be cancelled. Stop the SPA swap and restore this page's
    // URL; full-document Back/close remains subject to beforeunload instead.
    event.stopImmediatePropagation()
    history.pushState(recordingHistoryState, '', recordingURL)
    onBlocked()
  }
  window.addEventListener('beforeunload', beforeUnload)
  window.addEventListener(RECORDING_EXIT_EVENT, exit)
  window.addEventListener('click', click, true)
  window.addEventListener('popstate', popstate, true)
  return () => {
    window.removeEventListener('beforeunload', beforeUnload)
    window.removeEventListener(RECORDING_EXIT_EVENT, exit)
    window.removeEventListener('click', click, true)
    window.removeEventListener('popstate', popstate, true)
  }
}

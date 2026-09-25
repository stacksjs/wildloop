/** Hosts where the app is being developed rather than used. */
function isDevelopmentHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]'
    || hostname.endsWith('.localhost')
}

/**
 * Register the offline shell — outside development.
 *
 * The worker serves everything but HTML cache-first (`public/sw.js`), which is
 * what makes the app usable on a ridge with no signal. In development it means
 * the page comes back fresh while its client bundle does not: the markup has a
 * button wired to a function the cached script has never heard of, so the
 * control does nothing at all and no error is raised. That cost a long
 * debugging session on an iPhone, where there is no devtools to notice it in.
 *
 * Anything already registered is torn down and its caches dropped, since a
 * worker installed by an earlier visit keeps serving until it is told not to.
 */
export function registerWildloopServiceWorker(): void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return

  const hostname = typeof globalThis.location === 'undefined' ? '' : globalThis.location.hostname

  if (isDevelopmentHost(hostname)) {
    void navigator.serviceWorker.getRegistrations?.()
      .then(registrations => Promise.all(registrations.map(registration => registration.unregister())))
      .then(() => (typeof caches === 'undefined' ? [] : caches.keys()))
      .then(keys => Promise.all(keys.filter(key => key.startsWith('wildloop-')).map(key => caches.delete(key))))
      .catch(() => {
        // Best effort: a browser that refuses to list registrations is not a
        // reason to fail page start-up.
      })
    return
  }

  navigator.serviceWorker.register('/sw.js').catch(error => console.warn('[pwa] service worker registration failed', error))
}

/**
 * Getting the app back to its server after Craft gives up on it.
 *
 * craft-native 0.0.92 answers any failed or cancelled page load, a cancelled
 * one (-999) included, by loading the copy of the site bundled in the app at
 * craft://app, and it never goes back (craft-native/craft#252, fixed in #253,
 * not released yet). A live-reload racing a navigation, a dev-server restart,
 * a deploy or a flaky connection was enough. From that copy every API call
 * goes to craft://app/api/… and fails, so the app said "Could not reach the
 * server" until it was killed.
 *
 * The build writes the server it targets into the bundle (native-remote.json,
 * scripts/write-native-remote.ts). From the bundled copy this checks whether
 * that server answers and, once it does, loads the same page there. A failed
 * attempt leaves the page alone: Craft falls back only once per launch, so a
 * navigation that fails now just does not happen.
 */

export const NATIVE_REMOTE_FILE = '/native-remote.json'

/** How often to look for the server while the bundled copy is showing. */
export const NATIVE_REMOTE_RETRY_MS = 5000

/**
 * How long one look may take. A server that is still starting can accept the
 * connection and not answer; without a limit that look never ended, and
 * every retry after it waited on it.
 */
export const NATIVE_REMOTE_PROBE_TIMEOUT_MS = 4000

interface PageLocation {
  pathname: string
  search: string
  hash: string
}

/** The server path for a bundled page: craft://app/feed.html is /feed. */
export function serverPath(pathname: string): string {
  const path = pathname.replace(/\/index\.html$/, '/').replace(/\.html$/, '')
  return path || '/'
}

/** Where the same page lives on `remote`, or null if `remote` is not an http(s) origin. */
export function serverURLFor(remote: unknown, page: PageLocation): string | null {
  if (typeof remote !== 'string')
    return null
  try {
    const url = new URL(remote)
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      return null
    return `${url.origin}${serverPath(page.pathname)}${page.search}${page.hash}`
  }
  catch {
    return null
  }
}

/**
 * Whether to leave this page where it is for now.
 *
 * A run recorded while offline is being recorded right here; reloading the
 * recorder under it would end the session. The next attempt, after the
 * athlete has moved on, takes the app back.
 */
export function holdOnBundledPage(pathname: string): boolean {
  return serverPath(pathname) === '/record'
}

let started = false

export async function returnToServerFromBundledCopy(): Promise<void> {
  if (started || typeof location === 'undefined' || location.protocol !== 'craft:')
    return
  started = true

  // Not `response.ok`: Craft's file handler answers with a plain URLResponse,
  // which fetch reports as status 0 even when the file is there.
  const config = await fetch(NATIVE_REMOTE_FILE).then(response => response.json()).catch(() => null)
  const remote: unknown = config?.url
  // A bundled-only build has no server: this copy is the app.
  if (!serverURLFor(remote, location))
    return
  const origin = new URL(remote as string).origin

  let trying = false
  const attempt = async (): Promise<void> => {
    if (trying || holdOnBundledPage(location.pathname) || globalThis.document?.visibilityState === 'hidden')
      return
    trying = true
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), NATIVE_REMOTE_PROBE_TIMEOUT_MS)
    try {
      // Opaque, but it only resolves if the server answered at all.
      await fetch(`${origin}/manifest.webmanifest`, { mode: 'no-cors', cache: 'no-store', signal: abort.signal })
      const target = serverURLFor(origin, location)
      if (target)
        location.replace(target)
    }
    catch {
      // Still unreachable; the next attempt tries again.
    }
    finally {
      clearTimeout(timer)
      trying = false
    }
  }

  void attempt()
  setInterval(() => void attempt(), NATIVE_REMOTE_RETRY_MS)
  globalThis.addEventListener('online', () => void attempt())
  globalThis.document?.addEventListener('visibilitychange', () => void attempt())
}

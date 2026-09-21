/**
 * Which server a native build loads, and the rules that keep a build from
 * pointing somewhere it cannot reach.
 *
 * The server is fixed when the app is built: MOBILE_URL becomes
 * `devServerURL` in the generated craft.config.json. A phone cannot reach this
 * Mac's localhost, so a phone build pointed there opened on a dead server and
 * dropped to its bundled copy, where every API call fails. And a value with no
 * scheme (`localhost:3000`) was quietly given https:// by the generator.
 *
 * Checked by the scripts that build for a target (run-mobile-e2e.ts for the
 * Simulator, run-ios-device.ts for an iPhone), not by config/mobile.ts: the web
 * server loads that file too, and a bad MOBILE_URL must not stop it booting.
 */

export const PRODUCTION_URL = 'https://wildloop.org'
export const LOCAL_URL = 'http://localhost:3000'

export type MobileTarget = 'simulator' | 'device'

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function isLoopback(url: URL): boolean {
  return LOOPBACK_HOSTS.has(url.hostname)
}

/** The origin a build for `target` should load, or an error saying why not. */
export function resolveMobileServer(value: string | undefined, target: MobileTarget): string {
  const raw = value?.trim() || PRODUCTION_URL
  let url: URL
  try {
    url = new URL(raw)
  }
  catch {
    throw new Error(`The app's server must be an absolute http:// or https:// URL, not "${raw}".`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error(`The app's server must be an absolute http:// or https:// URL, not "${raw}".`)

  if (target === 'device' && isLoopback(url))
    throw new Error(`An iPhone cannot reach this Mac's ${url.host}. Build it against ${PRODUCTION_URL} (bun run preview:iphone), or pass --server with an https tunnel URL.`)
  if (url.protocol === 'http:' && !isLoopback(url))
    throw new Error(`Only this Mac (localhost) may be served over plain http; use https for ${url.host}.`)

  return url.origin
}

/** Read `--server=<url>` or `--server <url>` from a script's arguments. */
export function serverArgument(args: string[]): string | undefined {
  const index = args.findIndex(arg => arg === '--server' || arg.startsWith('--server='))
  if (index === -1)
    return undefined
  const value = args[index] === '--server' ? args[index + 1] : args[index].slice('--server='.length)
  if (!value || value.startsWith('--'))
    throw new Error('--server needs a URL, for example --server=http://localhost:3000')
  return value
}

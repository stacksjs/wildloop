/**
 * The isolated QA app for tests that talk to a real server without a browser.
 *
 * `scripts/start-recording-qa.ts` migrates a throwaway SQLite database, seeds
 * the fixture trails and starts the app (4320), its API (4321) and the
 * dashboard (4332). Never the developer's database.
 */
import type { Subprocess } from 'bun'

export const APP = 'http://127.0.0.1:4320'
export const API = 'http://127.0.0.1:4321/api'
export const DASHBOARD = 'http://127.0.0.1:4332/api'
export const READY_TIMEOUT_MS = 180_000

let server: Subprocess | null = null

async function reachable(url: string): Promise<boolean> {
  return await fetch(url).then(response => response.ok).catch(() => false)
}

/** Starts the servers, unless something already answers on those ports. */
export async function startQaServers(): Promise<void> {
  if (await reachable(`${API}/health`))
    return
  server = Bun.spawn(['bun', 'scripts/start-recording-qa.ts'], { stdout: 'inherit', stderr: 'inherit' })
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    // An app action, not just /json: the first one loads the whole app
    // runtime, which on a CI runner outlasts a test's 5 s timeout.
    if (await reachable(`${API}/trails`) && await reachable(`${DASHBOARD}/trails`))
      return
    await Bun.sleep(1000)
  }
  throw new Error('The recording QA servers did not come up')
}

export function stopQaServers(): void {
  server?.kill()
  server = null
}

/** The CSRF cookie value, which the double-submit check wants back as a header. */
export async function csrfToken(base: string): Promise<string> {
  const response = await fetch(`${base}/json`)
  const cookie = (response.headers.getSetCookie?.() ?? [])
    .map(value => value.match(/^X-CSRF-Token=([^;]+)/)?.[1])
    .find(Boolean)
  if (!cookie)
    throw new Error('The API did not set an X-CSRF-Token cookie')
  return decodeURIComponent(cookie)
}

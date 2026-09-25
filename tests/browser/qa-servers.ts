/**
 * The isolated QA app for tests that talk to a real server without a browser.
 *
 * `scripts/start-recording-qa.ts` migrates a throwaway SQLite database, seeds
 * the fixture trails and starts the app (4320), its API (4321) and the
 * dashboard (4332). Never the developer's database.
 *
 * One set of servers for the whole run, not one per file: `bun test` runs
 * every file in this process, and a file that tore its servers down at the
 * end pulled them out from under the next one, which had found them already
 * up and so held no handle of its own to wait on. They go when the process
 * goes.
 */
import type { Subprocess } from 'bun'

export const APP = 'http://127.0.0.1:4320'
export const API = 'http://127.0.0.1:4321/api'
export const DASHBOARD = 'http://127.0.0.1:4332/api'
export const READY_TIMEOUT_MS = 180_000

interface SharedServers {
  /** Ours to stop, or null when we found somebody else's already running. */
  process: Subprocess | null
  ready: Promise<void> | null
}

// On the global, because every test file imports its own copy of this module.
const shared: SharedServers = ((globalThis as typeof globalThis & { __wildloopQaServers?: SharedServers })
  .__wildloopQaServers ??= { process: null, ready: null })

/** Answers OK within a second: up, and not busy with its own startup work. */
async function reachable(url: string): Promise<boolean> {
  return await fetch(url, { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false)
}

function stop(): void {
  shared.process?.kill()
  shared.process = null
}

async function boot(): Promise<void> {
  // Something already answers there: a `buddy dev` a developer left running,
  // or the Playwright stack. Use it, and leave it alone afterwards.
  if (await reachable(`${API}/health`))
    return

  shared.process = Bun.spawn(['bun', 'scripts/start-recording-qa.ts'], { stdout: 'inherit', stderr: 'inherit' })
  // Not a reason for the test runner to stay alive: the servers outlive the
  // last file on purpose, so without this `bun test` finished every test and
  // then sat there holding the loop open for a child that never exits.
  shared.process.unref()
  process.once('exit', stop)
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => { stop(); process.exit(1) })

  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    // An app action answered promptly, not just /json: the first one loads
    // the whole app runtime, and the dashboard prewarms its render cache in
    // the background. On a CI runner either outlasted a test's 5 s timeout.
    if (await reachable(`${API}/trails`) && await reachable(`${DASHBOARD}/trails`))
      return
    await Bun.sleep(1000)
  }
  stop()
  throw new Error('The recording QA servers did not come up')
}

/** Start the servers once, and wait on that same start everywhere else. */
export function startQaServers(): Promise<void> {
  return (shared.ready ??= boot())
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

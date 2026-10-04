/**
 * The isolated QA app for tests that talk to a real server without a browser.
 *
 * `scripts/start-recording-qa.ts` migrates a throwaway SQLite database, seeds
 * the fixture trails and starts the app, its API and the dashboard on the
 * ports in qa-ports.ts (4320, 4321 and 4332 by default). Never the
 * developer's database.
 *
 * One set of servers for the whole run, not one per file: `bun test` runs
 * every file in this process, and a file that tore its servers down at the
 * end pulled them out from under the next one, which had found them already
 * up and so held no handle of its own to wait on. They go when the process
 * goes.
 */
import type { Subprocess } from 'bun'
import { QA_PORTS } from './qa-ports'

export const APP = `http://127.0.0.1:${QA_PORTS.app}`
export const API = `http://127.0.0.1:${QA_PORTS.api}/api`
export const DASHBOARD = `http://127.0.0.1:${QA_PORTS.dashboard}/api`
export const READY_TIMEOUT_MS = 180_000

/*
 * One rate-limit budget, many suites.
 *
 * Every suite here talks to the same servers from the same address, so they
 * share each throttle group's budget — 60 interactive requests a minute for
 * everything signed in. Which suite runs out depends only on the order the
 * files happen to run in, and the 429 it gets looks nothing like the
 * assertion it breaks: login-session failing because privacy-settings ran
 * first. So a request to these servers that is answered 429 waits out the
 * `Retry-After` and is sent once more, the way avatar-lifecycle always did
 * for its own routes. A second 429 is returned as it is, and fails loudly.
 *
 * A wait can outlast Bun's 5s default test timeout, so run these suites with
 * `--timeout 75000` (`bun run test:qa`, and CI). It has to be the flag:
 * `setDefaultTimeout` called from this module reaches only the first test
 * file that imports it, because the module is evaluated once per process.
 *
 * Wrapped on the global once, because every test file imports its own copy
 * of this module. Nothing in these suites asserts a 429.
 */
const QA_ORIGINS = [new URL(APP).origin, new URL(API).origin, new URL(DASHBOARD).origin]
const wrapped = globalThis as typeof globalThis & { __wildloopQaFetch?: boolean }
if (!wrapped.__wildloopQaFetch) {
  wrapped.__wildloopQaFetch = true
  const send = globalThis.fetch.bind(globalThis)
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const ours = QA_ORIGINS.some(origin => url.startsWith(origin))
    const response = await send(input as any, init)
    if (!ours || response.status !== 429)
      return response
    const retryAfter = Number(response.headers.get('Retry-After')
      ?? (await response.clone().json().catch(() => ({}))).retryAfter ?? 1)
    await Bun.sleep(Math.min(Math.max(Number.isFinite(retryAfter) ? retryAfter : 1, 1), 60) * 1000 + 500)
    return await send(input as any, init)
  }) as typeof fetch
}

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

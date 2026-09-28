/**
 * The recording API's storage guarantees: GPS time is kept as recorded, a
 * retried upload does not create a second activity, and another user's or a
 * guest's recording cannot be reached.
 *
 * This was the last test in `recording.pw.ts`, where it was the only case that
 * never touched `page` — it shelled out to `scripts/test-recording-api.ts` and
 * asserted on its stdout. Nothing about it needs a browser, so it belongs here,
 * under `bun test`, with the rest of the API-level checks.
 *
 * `scripts/test-recording-api.ts` remains the suite itself: it is a standalone
 * Bun script with its own assertions, runnable by hand against a booted QA
 * stack. This wrapper boots that stack and reports the script's outcome.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'bun:test'
import { READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

const REPO_ROOT = new URL('../..', import.meta.url)

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
}, READY_TIMEOUT_MS + 10_000)

describe.skipIf(!qa)('recording API', () => {
  it('stores GPS time, deduplicates retries and refuses foreign/guest access', async () => {
    const { stdout } = await promisify(execFile)('bun', ['scripts/test-recording-api.ts'], { cwd: REPO_ROOT })

    // The script prints a PASS: line per guarantee it checked, and throws on
    // the first assertion that fails, so a non-empty PASS is the whole signal.
    expect(stdout).toContain('PASS:')
  }, READY_TIMEOUT_MS)
})

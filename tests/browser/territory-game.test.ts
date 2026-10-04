/**
 * The territory game end to end: two accounts claim, split, contest and
 * defend land through the same endpoints the recorder calls, and the map,
 * leaderboard, battle feed and notifications are checked against it.
 *
 * `scripts/test-territory-game.ts` is the suite itself, runnable by hand
 * against a booted QA stack; this wrapper boots that stack and reports the
 * script's outcome, the same way `recording-api.test.ts` does.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'bun:test'
import { READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
const qa = process.env.RECORDING_QA === '1'

const REPO_ROOT = new URL('../..', import.meta.url)

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
}, READY_TIMEOUT_MS + 10_000)

describe.skipIf(!qa)('territory game', () => {
  it('claims, splits, contests and defends, and every game read agrees', async () => {
    const { stdout } = await promisify(execFile)('bun', ['scripts/test-territory-game.ts'], { cwd: REPO_ROOT })

    // The script throws on the first check that fails, so PASS is the signal.
    expect(stdout).toContain('PASS:')
  }, READY_TIMEOUT_MS)
})

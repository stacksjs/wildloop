import { describe, expect, it } from 'bun:test'

/**
 * The test suite does not file issues.
 *
 * `config/logging.ts` attaches loghq and bughq as transports, and bughq turns
 * every `log.error` into an issue its owner is emailed about. Both were
 * attached unconditionally — `environment: process.env.APP_ENV` labels an
 * event, it does not withhold one — so running the suite filed real issues
 * from deliberate failures.
 *
 * What surfaced it: `tests/unit/google-callback.test.ts` injects
 *
 *     UNIQUE constraint failed: user_identities.provider, user_identities.provider_user_id
 *
 * to prove the Google callback refuses a sign-in it cannot record. That is the
 * test passing. It arrived by email as "New issue in wildloop", tagged
 * `Environment: test`, pointing at a path inside somebody's worktree — and in
 * the inbox it is indistinguishable from the same constraint failing against
 * real accounts.
 */

describe('logging transports', () => {
  it('attaches none of them under bun test', async () => {
    const { default: logging } = await import('../../config/logging')

    expect(process.env.NODE_ENV, 'bun test should set NODE_ENV').toBe('test')
    expect(logging.transports, 'the suite must not ship logs or file issues').toEqual([])
  })

  /*
   * The gate reads the environment rather than, say, checking for a global
   * the test runner happens to define, so it holds for anything run with
   * APP_ENV=test — a CI job, a QA stack, a script somebody writes later.
   */
  it('is decided by the environment, not by the runner', async () => {
    const source = await Bun.file('config/logging.ts').text()

    expect(source).toContain("process.env.APP_ENV !== 'test'")
    expect(source).toContain("process.env.NODE_ENV !== 'test'")
  })

  /*
   * And the keys are still there to be attached outside test — a gate that
   * worked by deleting the transports would pass the test above and report
   * nothing from production either.
   */
  it('still carries both transports for the environments that report', async () => {
    const source = await Bun.file('config/logging.ts').text()

    expect(source).toContain('loghqTransport(')
    expect(source).toContain('bughqTransport(')
  })
})

import { describe, expect, it } from 'bun:test'

/**
 * The test suite does not file issues.
 *
 * `config/logging.ts` attaches loghq and bughq, and bughq turns every
 * `log.error` into an issue its owner is emailed about. Both were attached
 * unconditionally — `environment: process.env.APP_ENV` labels an event, it does
 * not withhold one — so running the suite filed real issues from deliberate
 * failures.
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
 *
 * Why the assertions below are about a client and a registration rather than
 * about the `transports` array: `@stacksjs/logging` never reads that array.
 * `bughqTransport()` is what does the work — calling it constructs the ingest
 * client (which POSTs a heartbeat of its own) and registers the transport with
 * the logger from inside. So the array is not the door; CALLING the factory is,
 * and the gate's job is to not call it.
 */

describe('logging transports', () => {
  it('builds no transports under bun test', async () => {
    const { default: logging } = await import('../../config/logging')

    expect(process.env.NODE_ENV, 'bun test should set NODE_ENV').toBe('test')
    expect(logging.transports, 'the suite must not ship logs or file issues').toEqual([])
  })

  /*
   * The one that would have caught the original defect: importing the config
   * must not leave an ingest client behind. `@bughq/stacks` keeps its client on
   * a well-known global symbol, so its absence is checkable from here.
   */
  it('constructs no ingest client, and registers nothing with the logger', async () => {
    const logging: any = await import('@stacksjs/logging')
    await import('../../config/logging')
    // Registration is `void import('@stacksjs/logging').then(...)` inside the
    // factory, so give that microtask chain a turn before looking.
    await new Promise(resolve => setTimeout(resolve, 50))

    expect((globalThis as any)[Symbol.for('@bughq/stacks:client')] ?? null, 'no bughq client may exist under test').toBeNull()
    expect((logging.transports?.() ?? []).map((t: any) => t.name), 'no transport may be registered under test').toEqual([])
  })

  /*
   * The gate reads the environment rather than, say, checking for a global the
   * test runner happens to define, so it holds for anything run with APP_ENV or
   * NODE_ENV of test — a CI job, a QA stack, a script somebody writes later.
   */
  it('is decided by the environment, not by the runner', async () => {
    const source = await Bun.file('config/logging.ts').text()

    expect(source).toContain("process.env.APP_ENV !== 'test'")
    expect(source).toContain("process.env.NODE_ENV !== 'test'")
  })

  /*
   * And the factories are still there to be called outside test — a gate that
   * worked by deleting them would pass everything above and report nothing from
   * production either.
   */
  it('still carries both transports for the environments that report', async () => {
    const source = await Bun.file('config/logging.ts').text()

    expect(source).toContain('loghqTransport(')
    expect(source).toContain('bughqTransport(')
  })
})

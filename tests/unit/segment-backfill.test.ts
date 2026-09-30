import { describe, expect, it } from 'bun:test'

/**
 * `buddy segments:backfill`, as a contract rather than as a run.
 *
 * The matching it does is covered by `segment-matching.test.ts`; what is worth
 * pinning here is the shape of the command, because a backfill is a thing
 * somebody runs against production at two in the morning on the strength of
 * what its flags appear to promise.
 *
 * Two of those promises are load-bearing. `--dry-run` must not write, or the
 * flag is a trap. And paging must not use an offset: a backfill that walks
 * past rows because the set shifted under it is one nobody can tell has
 * finished.
 */

const COMMAND = 'app/Commands/BackfillSegmentEfforts.ts'
const SUPPORT = 'app/Support/segmentEfforts.ts'

async function command(): Promise<string> {
  return await Bun.file(COMMAND).text()
}

describe('segments:backfill', () => {
  it('offers the flags it documents', async () => {
    const source = await command()
    for (const flag of ['--segment', '--limit', '--batch', '--since', '--dry-run'])
      expect(source, flag).toContain(flag)
  })

  /*
   * A dry run that writes is worse than no dry run, because somebody trusted
   * it. The flag is carried into the matcher rather than checked only in the
   * command, so there is one place that decides whether a row is written.
   */
  it('carries dry-run down to the thing that writes', async () => {
    expect(await command()).toContain('dryRun: options.dryRun')

    const support = await Bun.file(SUPPORT).text()
    // The insert is skipped on a dry run, and the count update with it.
    expect(support).toContain('if (activity.dryRun)')
    expect(support).toContain('if (matched > 0 && !activity.dryRun)')
  })

  /*
   * Keyset paging, not OFFSET.
   *
   * `LIMIT ... OFFSET n` over a set that is being written to skips rows: an
   * activity saved mid-run shifts everything after it, and the backfill steps
   * over whatever moved across the boundary. Walking on `id >` cannot.
   */
  it('pages on the last id rather than an offset', async () => {
    const source = await command()
    expect(source).toContain('id > ${lastId}')
    // The SQL keyword, case-sensitively: the comment above it explains why an
    // offset is wrong, and is allowed to say the word.
    expect(source).not.toMatch(/\bOFFSET\b/)
  })

  it('only reads activities that have a route to match', async () => {
    expect(await command()).toContain('gpx_data IS NOT NULL')
  })

  it('refuses a --segment that does not exist rather than matching everything', async () => {
    // Silently ignoring an unknown id would quietly widen the run to the whole
    // catalog, which is the opposite of what the flag was reached for.
    const source = await command()
    expect(source).toContain('No segment with id')
    expect(source).toContain('ExitCode.FatalError')
  })

  it('recounts efforts after writing, so a count cannot drift', async () => {
    const source = await command()
    expect(source).toMatch(/UPDATE segments\s+SET effort_count = \(SELECT COUNT\(\*\)/)
  })
})

describe('the numbers it reports', () => {
  /*
   * A re-run matches the same efforts and the unique index ignores them, so
   * the figure is what was found rather than what was written. Saying
   * "recorded" on a second run would claim work that did not happen.
   */
  it('says matched rather than recorded', async () => {
    const source = await command()
    expect(source).toContain('effort(s) matched')
    expect(source).not.toContain('effort(s) recorded')
  })

  it('says plainly when a dry run wrote nothing', async () => {
    expect(await command()).toContain('Dry run: nothing was written.')
  })
})

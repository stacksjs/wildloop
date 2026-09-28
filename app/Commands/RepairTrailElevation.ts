import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { db } from '@stacksjs/orm'
import { ExitCode } from '@stacksjs/types'
import { climbAlong } from '../Support/routing'
import { elevationOutcome, elevationRecord, elevationRequest } from '../Support/trailElevation'

interface RepairOptions {
  batch?: number | string
  limit?: number | string
  concurrency?: number | string
  country?: string
  dryRun?: boolean
}

/** Rows read from the database at a time. One query per batch, not per trail. */
const DEFAULT_BATCH = 500

/**
 * Requests in flight against the routing server.
 *
 * Ours (`VALHALLA_URL`) is a machine we run, and this is the only thing
 * talking to it during a backfill — but the public fallback is somebody
 * else's, and a backfill that hammers it would deserve the block it got.
 * Four is brisk against ours and polite to theirs.
 */
const DEFAULT_CONCURRENCY = 4

/**
 * `buddy trails:repair-elevation` — fill in elevation gain from stored lines.
 *
 * The catalog carries 596,556 trails and almost no ascent: a sample of 400
 * production rows, taken across four offsets, found elevation gain on none of
 * them (#1003). So the trail page prints "Not recorded" where the number
 * people check second belongs, and difficulty — inferred from length alone
 * because ascent is missing — grades a 0.1-mile scramble easy and a flat
 * 250-mile rail-trail hard (#1004).
 *
 * Nothing new is needed to fix it. Every trail already stores its line, and
 * `climbAlong()` already turns a line into gain and loss through Valhalla for
 * the route builder. This walks the catalog and asks that question per trail.
 *
 * Resumable by construction, and it finishes. Selection is on
 * `elevation_checked_at` rather than on `elevation`, because those are
 * different questions: a gain of zero is never written to `elevation` (that
 * column treats 0 as "not recorded", so writing it would claim a measurement
 * the page then denies), and a third of this catalog measures exactly zero —
 * 50 of a 150-trail production sample, every one of them under half a mile.
 * Keyed on the gain, those rows were measured, discarded and measured again on
 * the next run, forever. Keyed on the answer having been reached, a stopped
 * run leaves the rest selectable and a completed run is a genuine no-op.
 *
 * Every row that reaches an answer is stamped, including the ones with no gain
 * to write: a line too coarse to measure and a reading too large to be a trail
 * are both settled until the geometry changes. Only a transport failure is
 * left unstamped, because that is the one outcome a re-run can change.
 */
export default function (cli: CLI) {
  cli
    .command('trails:repair-elevation', 'Fill in trail elevation gain from the stored geometry')
    .option('--batch [count]', 'Rows read per query', { default: DEFAULT_BATCH })
    .option('--limit [count]', 'Stop after this many trails (0 = all)', { default: 0 })
    .option('--concurrency [count]', 'Elevation requests in flight', { default: DEFAULT_CONCURRENCY })
    .option('--country <code>', 'Only trails in this country (e.g. US)')
    .option('--dry-run', 'Measure and report without writing', { default: false })
    .action(async (options: RepairOptions) => {
      intro('trails:repair-elevation')

      const batchSize = Math.max(1, Number(options.batch ?? DEFAULT_BATCH) || DEFAULT_BATCH)
      const limit = Math.max(0, Number(options.limit ?? 0) || 0)
      const concurrency = Math.max(1, Number(options.concurrency ?? DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY)
      const country = options.country?.trim().toUpperCase() || null

      // Rows that could not be measured are left out here rather than skipped
      // in the loop, so a re-run does not keep paying for them.
      const countable = await db.sql`
        SELECT COUNT(*) AS total
        FROM trails
        WHERE elevation_checked_at IS NULL
          AND geometry IS NOT NULL
          AND length(geometry) > 2
          AND (${country} IS NULL OR country = ${country})
      `.execute() as Array<{ total: number }>
      const outstanding = Number(countable?.[0]?.total ?? 0)

      if (outstanding === 0) {
        log.success('Nothing to repair — every measurable trail has been measured.')
        outro('Done')
        return
      }

      const target = limit > 0 ? Math.min(limit, outstanding) : outstanding
      log.info(`${target.toLocaleString()} of ${outstanding.toLocaleString()} trail(s) never measured`)
      if (options.dryRun)
        log.warn('Dry run: measuring, but not writing.')

      let measured = 0
      let measurable = 0
      let written = 0
      let skipped = 0
      let flat = 0
      let rejected = 0
      let failed = 0
      let totalGain = 0

      /**
       * Mark a trail answered.
       *
       * Separate from writing the gain, because most answers have no gain to
       * write: a flat trail, a line too coarse to measure, a reading too large
       * to be true. Each is settled until the geometry changes, and each used
       * to be asked again on every run.
       */
      async function settle(id: number, gainFt: number | null): Promise<void> {
        if (options.dryRun)
          return
        const at = new Date().toISOString()
        if (gainFt === null)
          await db.sql`UPDATE trails SET elevation_checked_at = ${at} WHERE id = ${id}`.execute()
        else
          await db.sql`UPDATE trails SET elevation = ${gainFt}, elevation_checked_at = ${at} WHERE id = ${id}`.execute()
      }

      /** One trail: measure it, and write the gain when there is one. */
      async function repair(row: { id: number, geometry: string }): Promise<void> {
        const request = elevationRequest(row.geometry)
        if ('status' in request) {
          // Nothing to ask a routing server, and nothing a re-run would ask
          // differently — the line is as coarse as it will ever be.
          skipped++
          await settle(row.id, null)
          return
        }

        let gainFt: number
        try {
          ;({ gainFt } = await climbAlong(request.line.map(([lat, lng]) => ({ lat, lng }))))
        }
        catch (error) {
          // One trail failing must not end the run: every other row is an
          // independent question, and a re-run picks this one up again. Left
          // unstamped on purpose — a transport failure is the one outcome that
          // a later run can genuinely change.
          failed++
          log.debug(`  trail ${row.id}: ${error instanceof Error ? error.message : error}`)
          return
        }

        const outcome = elevationOutcome(gainFt)
        measured++
        if (outcome.status === 'rejected') {
          rejected++
          log.debug(`  trail ${row.id}: ${outcome.gainFt.toLocaleString()} ft is not a trail, leaving it unrecorded`)
          await settle(row.id, null)
          return
        }
        const record = elevationRecord(outcome)
        if (record.gainFt === null) {
          // Measured, and flat. The gain stays unwritten because the column
          // reads 0 as "not recorded", but the question has been answered.
          flat++
          await settle(row.id, null)
          return
        }

        measurable++
        totalGain += record.gainFt
        if (options.dryRun)
          return

        await settle(row.id, record.gainFt)
        written++
      }

      let seen = 0
      // Paged by id rather than OFFSET: writing to the rows being paged over
      // moves them out of the result set, so an offset would step past the
      // trails that slid down into the window it already read.
      let after = 0
      while (seen < target) {
        const take = Math.min(batchSize, target - seen)
        const rows = await db.sql`
          SELECT id, geometry
          FROM trails
          WHERE elevation_checked_at IS NULL
            AND geometry IS NOT NULL
            AND length(geometry) > 2
            AND (${country} IS NULL OR country = ${country})
            AND id > ${after}
          ORDER BY id
          LIMIT ${take}
        `.execute() as Array<{ id: number, geometry: string }>

        if (!rows || rows.length === 0)
          break

        after = Number(rows[rows.length - 1].id)
        seen += rows.length

        for (let i = 0; i < rows.length; i += concurrency)
          await Promise.all(rows.slice(i, i + concurrency).map(repair))

        log.info(`  ${seen.toLocaleString()}/${target.toLocaleString()} · ${written.toLocaleString()} written`)
      }

      log.info('')
      log.info(`measured  ${measured.toLocaleString()}`)
      log.info(`written   ${written.toLocaleString()}${options.dryRun ? ' (dry run)' : ''}`)
      log.info(`flat      ${flat.toLocaleString()} (measured at no gain, marked answered)`)
      log.info(`skipped   ${skipped.toLocaleString()} (nothing measurable in the line)`)
      if (rejected > 0)
        log.info(`rejected  ${rejected.toLocaleString()} (gain too large to be a trail)`)
      // Averaged over what was measurable, so a dry run reports the same
      // figure the real run would write.
      if (measurable > 0)
        log.info(`average   ${Math.round(totalGain / measurable).toLocaleString()} ft`)

      if (failed > 0) {
        log.warn(`${failed.toLocaleString()} trail(s) could not be measured — re-run to pick them up.`)
        process.exitCode = ExitCode.FatalError
        return
      }

      outro('Done')
    })
}

import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { db } from '@stacksjs/orm'
import { ExitCode } from '@stacksjs/types'
import { parseTrackSamples } from '../../resources/functions/activity-integrity'
import { recordSegmentEfforts } from '../Support/segmentEfforts'

interface BackfillOptions {
  segment?: number | string
  limit?: number | string
  batch?: number | string
  since?: string
  dryRun?: boolean
}

/** Activities read from the database at a time. One query per batch, not per activity. */
const DEFAULT_BATCH = 100

/**
 * `buddy segments:backfill` — put existing runs on the boards they belong on.
 *
 * A segment only knows about activities saved after it was drawn: matching
 * happens on save, and the activity a segment was cut from is matched when it
 * is created (#959). Everybody else's runs over the same ground are invisible
 * until this is run, so a new segment opens with a board of one.
 *
 * Iterates activities rather than segments because an activity carries no
 * bounding box, so there is no cheap way to ask which ones came near a
 * segment — every track has to be parsed either way. Segments do have one, and
 * `recordSegmentEfforts` uses it to narrow the candidates for each activity.
 *
 * That is fine at today's numbers and will not stay fine: the honest fix when
 * it stops being fine is a bounding box on `activities`, which would let this
 * ask the database which runs went near a segment instead of reading them all.
 */
export default function (cli: CLI) {
  cli
    .command('segments:backfill', 'Match existing activities against segments')
    .option('--segment <id>', 'Only this segment, for one that was just drawn')
    .option('--limit [count]', 'Stop after this many activities (0 = all)', { default: 0 })
    .option('--batch [count]', 'Activities read per query', { default: DEFAULT_BATCH })
    .option('--since <date>', 'Only activities completed on or after this date (YYYY-MM-DD)')
    .option('--dry-run', 'Report what would be recorded without writing', { default: false })
    .action(async (options: BackfillOptions) => {
      intro('segments:backfill')

      const onlySegmentId = options.segment === undefined ? null : Number(options.segment)
      if (onlySegmentId !== null && (!Number.isInteger(onlySegmentId) || onlySegmentId <= 0)) {
        log.error('--segment takes a segment id.')
        process.exitCode = ExitCode.FatalError
        return
      }

      const batchSize = Math.max(1, Number(options.batch ?? DEFAULT_BATCH) || DEFAULT_BATCH)
      const limit = Math.max(0, Number(options.limit ?? 0) || 0)
      const since = options.since?.trim() || null

      if (onlySegmentId !== null) {
        const found = await db.sql`SELECT name FROM segments WHERE id = ${onlySegmentId}`.execute() as Array<{ name: string }>
        if (!found?.length) {
          log.error(`No segment with id ${onlySegmentId}.`)
          process.exitCode = ExitCode.FatalError
          return
        }
        log.info(`Only "${found[0].name}".`)
      }

      const segmentCount = (await db.sql`SELECT COUNT(*) AS total FROM segments`.execute() as Array<{ total: number }>)[0]?.total ?? 0
      if (Number(segmentCount) === 0) {
        log.success('No segments to match against yet.')
        outro('Done')
        return
      }

      // Only activities with a recorded line can be on a board at all, and
      // never one the integrity checks refused: its times are why.
      const countable = await db.sql`
        SELECT COUNT(*) AS total
        FROM activities
        WHERE gpx_data IS NOT NULL
          AND integrity_status <> 'rejected'
          AND (${since} IS NULL OR completed_at >= ${since})
      `.execute() as Array<{ total: number }>
      const outstanding = Number(countable?.[0]?.total ?? 0)

      if (outstanding === 0) {
        log.success('No recorded activities to match.')
        outro('Done')
        return
      }

      const target = limit > 0 ? Math.min(limit, outstanding) : outstanding
      log.info(`${target.toLocaleString()} activities to check against ${Number(segmentCount).toLocaleString()} segment(s).${options.dryRun ? ' Dry run.' : ''}`)

      let scanned = 0
      let matched = 0
      let withEfforts = 0
      // Keyed on id rather than an offset: an offset walks past rows when the
      // set shifts under it, and a backfill that silently skips activities is
      // one nobody can tell has finished.
      let lastId = 0

      while (scanned < target) {
        const rows = await db.sql`
          SELECT id, user_id, activity_type, gpx_data
          FROM activities
          WHERE gpx_data IS NOT NULL
            AND integrity_status <> 'rejected'
            AND id > ${lastId}
            AND (${since} IS NULL OR completed_at >= ${since})
          ORDER BY id ASC
          LIMIT ${Math.min(batchSize, target - scanned)}
        `.execute() as Array<{ id: number, user_id: number, activity_type: string, gpx_data: string }>

        if (!rows?.length)
          break

        for (const row of rows) {
          lastId = Number(row.id)
          scanned += 1

          const samples = parseTrackSamples(row.gpx_data)
          const found = await recordSegmentEfforts({
            id: Number(row.id),
            userId: Number(row.user_id),
            activityType: String(row.activity_type),
            samples: samples.map(sample => ({ lat: sample.lat, lng: sample.lng, time: sample.time })),
            dryRun: options.dryRun,
            onlySegmentId: onlySegmentId ?? undefined,
          })

          matched += found
          if (found > 0)
            withEfforts += 1
        }

        log.info(`  ${scanned.toLocaleString()} / ${target.toLocaleString()} checked, ${matched.toLocaleString()} effort(s)`)
      }

      /*
       * Recounted at the end rather than per activity: `recordSegmentEfforts`
       * already keeps the count true as it writes, but a dry run writes
       * nothing and a re-run writes nothing new, and a count that is right
       * either way is cheaper to trust than one that depends on which.
       */
      if (!options.dryRun && matched > 0) {
        await db.sql`
          UPDATE segments
          SET effort_count = (SELECT COUNT(*) FROM segment_efforts WHERE segment_id = segments.id)
        `.execute()
      }

      log.info('')
      log.info(`  activities checked   ${scanned.toLocaleString()}`)
      log.info(`  with an effort       ${withEfforts.toLocaleString()}`)
      log.info(`  efforts matched      ${matched.toLocaleString()}`)

      if (options.dryRun)
        log.success('Dry run: nothing was written.')
      // "Matched", not "recorded": a re-run matches the same efforts again and
      // the unique index ignores them, so this number is what was found rather
      // than what was written.
      else log.success(`${matched.toLocaleString()} effort(s) matched. Anything already on a board was left as it was.`)

      outro('Done')
    })
}

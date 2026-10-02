import type { CLI } from '@stacksjs/types'
import { intro, log, outro } from '@stacksjs/cli'
import { db } from '@stacksjs/orm'
import { deriveDifficulty } from '../Ingest/normalize'

interface RegradeOptions {
  limit?: number | string
  batch?: number | string
  dryRun?: boolean
}

const DEFAULT_BATCH = 500

/**
 * `buddy trails:regrade-difficulty` — re-grade trails whose ascent is now known.
 *
 * A trail's difficulty is decided once, at ingest, from distance and ascent.
 * For most of the catalog ascent was zero at that moment — the NPS and Forest
 * Service layers publish no elevation and OSM rarely tags it — so the grade
 * was distance alone, and Mist Trail in Yosemite, 2.67 miles and a thousand
 * feet up to Vernal Fall, is stored as `easy` (#1004).
 *
 * The elevation backfill (#1003) has since filled a quarter of the catalog and
 * keeps going, but nothing re-ran the grader behind it. This does, for the
 * rows that have an ascent to grade on.
 *
 * Only touches trails with `elevation > 0`. A trail with no measured ascent
 * would re-grade to exactly what it already has — distance alone — so writing
 * it back would be a no-op with an UPDATE's cost. Those rows are marked
 * estimated at read time instead, from the same zero.
 */
export default function (cli: CLI) {
  cli
    .command('trails:regrade-difficulty', 'Re-grade trails whose ascent is now measured')
    .option('--limit [count]', 'Stop after this many trails (0 = all)', { default: 0 })
    .option('--batch [count]', 'Trails read per query', { default: DEFAULT_BATCH })
    .option('--dry-run', 'Report what would change without writing', { default: false })
    .action(async (options: RegradeOptions) => {
      intro('trails:regrade-difficulty')

      const batchSize = Math.max(1, Number(options.batch ?? DEFAULT_BATCH) || DEFAULT_BATCH)
      const limit = Math.max(0, Number(options.limit ?? 0) || 0)

      const countable = await db.sql`
        SELECT COUNT(*) AS total FROM trails WHERE elevation > 0
      `.execute() as Array<{ total: number }>
      const outstanding = Number(countable?.[0]?.total ?? 0)

      if (outstanding === 0) {
        log.warn('No trail has a measured ascent yet — run the elevation backfill first.')
        outro('Done')
        return
      }

      const target = limit > 0 ? Math.min(limit, outstanding) : outstanding
      log.info(`${target.toLocaleString()} trail(s) with a measured ascent.${options.dryRun ? ' Dry run.' : ''}`)

      let scanned = 0
      let changed = 0
      const movement = new Map<string, number>()
      // Keyed on id rather than an offset, so a row written mid-run cannot
      // shift the window and skip whatever crossed the boundary.
      let lastId = 0

      while (scanned < target) {
        const rows = await db.sql`
          SELECT id, distance, elevation, difficulty
          FROM trails
          WHERE elevation > 0 AND id > ${lastId}
          ORDER BY id ASC
          LIMIT ${Math.min(batchSize, target - scanned)}
        `.execute() as Array<{ id: number, distance: number, elevation: number, difficulty: string }>

        if (!rows?.length)
          break

        for (const row of rows) {
          lastId = Number(row.id)
          scanned += 1

          const { difficulty } = deriveDifficulty(Number(row.distance ?? 0), Number(row.elevation))
          if (difficulty === row.difficulty)
            continue

          changed += 1
          const key = `${row.difficulty} -> ${difficulty}`
          movement.set(key, (movement.get(key) ?? 0) + 1)

          if (!options.dryRun) {
            await db.sql`
              UPDATE trails SET difficulty = ${difficulty}, updated_at = ${new Date().toISOString()}
              WHERE id = ${Number(row.id)}
            `.execute()
          }
        }

        log.info(`  ${scanned.toLocaleString()} / ${target.toLocaleString()} checked, ${changed.toLocaleString()} regraded`)
      }

      log.info('')
      log.info(`  trails checked   ${scanned.toLocaleString()}`)
      log.info(`  regraded         ${changed.toLocaleString()}`)
      for (const [move, count] of [...movement.entries()].sort((a, b) => b[1] - a[1]))
        log.info(`    ${move}  ${count.toLocaleString()}`)

      if (options.dryRun)
        log.success('Dry run: nothing was written.')
      else log.success(`${changed.toLocaleString()} trail(s) regraded.`)

      outro('Done')
    })
}

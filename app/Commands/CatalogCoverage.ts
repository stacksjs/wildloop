import type { CLI } from '@stacksjs/types'
import { intro, log, outro } from '@stacksjs/cli'
import { db } from '@stacksjs/orm'
import { isStockTrailPhoto } from '../../resources/functions/stock-photos'
import { coverageOf, percent, sampleWindows } from '../Support/catalogCoverage'

interface CoverageOptions {
  sample?: number | string
  json?: boolean
}

/** Rows to read. Enough to be worth comparing, small enough to run in a second. */
const DEFAULT_SAMPLE = 400

/**
 * `buddy trails:catalog-coverage` — how much of the catalog carries the data
 * somebody opens a trail page to read.
 *
 * #1002 is a measurement, and the measurement was not repeatable. It was taken
 * by hand against the live API at offsets 0, 60k, 200k and 400k; since then
 * the default ordering changed, so offset 0 selects different trails, and
 * paging past roughly 60,000 answers 520 (#1008), so half the sample points
 * cannot be fetched. Re-running it by hand produced a difficulty split four
 * times harder than the baseline, entirely because the two samples were of
 * different trails.
 *
 * This samples evenly by id instead. Ids do not move when the ordering
 * changes, the query does not slow down the deeper it reaches, and two runs a
 * month apart measure the same thing — which is the only way the question
 * "did any of this work" has an answer.
 */
export default function (cli: CLI) {
  cli
    .command('trails:catalog-coverage', 'Measure what fraction of the catalog carries real data')
    .option('--sample [count]', 'How many trails to sample across the id space', { default: DEFAULT_SAMPLE })
    .option('--json', 'Emit the report as JSON, for recording over time', { default: false })
    .action(async (options: CoverageOptions) => {
      if (!options.json)
        intro('trails:catalog-coverage')

      const sample = Math.max(1, Number(options.sample ?? DEFAULT_SAMPLE) || DEFAULT_SAMPLE)

      const bounds = (await db.sql`
        SELECT MIN(id) AS lo, MAX(id) AS hi, COUNT(*) AS total FROM trails
      `.execute() as Array<{ lo: number, hi: number, total: number }>)[0]

      const total = Number(bounds?.total ?? 0)
      if (total === 0) {
        log.warn('The catalog is empty.')
        outro('Done')
        return
      }

      /*
       * One row per window rather than one query per trail: `id >= window`
       * with `LIMIT 1` lands on the first real trail at or after each boundary,
       * which handles the gaps that deletions and the ingest leave behind.
       */
      const windows = sampleWindows(Number(bounds.lo), Number(bounds.hi), Math.min(sample, total))
      const rows: Array<Record<string, any>> = []
      const seen = new Set<number>()

      for (const window of windows) {
        const found = await db.sql`
          SELECT id, elevation, rating, review_count, image, dogs_allowed, surface, difficulty
          FROM trails WHERE id >= ${window} ORDER BY id ASC LIMIT 1
        `.execute() as Array<Record<string, any>>

        const row = found?.[0]
        // Two windows can land on the same trail where ids are sparse. Counting
        // it twice would weight that stretch of the catalog double.
        if (row && !seen.has(Number(row.id))) {
          seen.add(Number(row.id))
          rows.push(row)
        }
      }

      const report = coverageOf(rows, isStockTrailPhoto)

      if (options.json) {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({ catalog: total, ...report }, null, 2))
        return
      }

      const line = (label: string, count: number) =>
        log.info(`  ${label.padEnd(18)}${String(count).padStart(5)} / ${report.sampled}   ${percent(count, report.sampled).padStart(6)}`)

      log.info('')
      log.info(`  ${total.toLocaleString()} trails in the catalog, ${report.sampled} sampled evenly by id.`)
      log.info('')
      line('Elevation gain', report.fields.elevation)
      line('Star rating', report.fields.rating)
      line('Any review', report.fields.reviews)
      line('Real photo', report.fields.realPhoto)
      line('Dogs policy', report.fields.dogsPolicy)
      line('Surface', report.fields.surface)
      log.info('')
      log.info(`  of the photos: ${report.fields.stockPhoto} stock, ${report.fields.noPhoto} none at all`)

      const grades = Object.entries(report.difficulty).sort((a, b) => b[1] - a[1])
      log.info('')
      log.info(`  Difficulty: ${grades.map(([grade, count]) => `${count} ${grade}`).join(', ')}`)

      /*
       * The baseline is printed beside the result rather than left in an issue,
       * because a number with nothing to compare it to is not a measurement.
       * It is quoted as a fraction of 400 because that is the sample it came
       * from, and the percentages are what travel between runs.
       */
      log.info('')
      log.info('  Baseline, 400 trails sampled 25 Sep 2026 (#1002):')
      log.info('    elevation 0%, rating 0%, reviews 0%, real photo 0%, dogs 0.3%, surface 58%')

      outro('Done')
    })
}

import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { ExitCode } from '@stacksjs/types'
import { withBestTrailCovers } from '../Support/trailCovers'
import { DEFAULT_NIGHTLY_LIMIT, PICKS_PER_METRO, SEARCH_RADIUS_METRES, sourceTrailPhotos } from '../Support/trailPhotoQueue'

interface SourceOptions {
  limit?: number | string
  radius?: number | string
  perMetro?: number | string
}

/**
 * `buddy trails:source-photos` — look on Wikimedia Commons for photographs of
 * the trails people open, and queue them for review on /admin/photos (#1006).
 *
 * The nightly job, and the legwork `trails:photo-coverage --search` used to
 * leave on the terminal: the same geosearch, plus a search by each trail's
 * name narrowed to files near it or naming its park or region
 * (trailPhotoNameSearch.ts), aimed by demand and then by what
 * ranks first around the biggest cities (trailPhotoQueue.ts), with every
 * candidate written down as pending instead of printed and forgotten.
 *
 * It approves nothing. A title naming a trail and a camera standing near it
 * are evidence, not proof, so each candidate waits for a person to look at it
 * beside the trail's line. Files under a licence a cover cannot use are
 * written as rejected with the reason, and never shown.
 *
 * Polite by construction: two requests a trail, one at a time, a second apart, with a
 * User-Agent that says who is asking and `maxlag` set; told to slow down
 * twice, it stops for the night. A trail it has looked up is not asked about
 * again for 90 days.
 */
export default function (cli: CLI) {
  cli
    .command('trails:source-photos', 'Queue Wikimedia Commons photo candidates for the trails people open')
    .option('--limit [count]', 'Trails to look up tonight', { default: DEFAULT_NIGHTLY_LIMIT })
    .option('--radius [metres]', 'Metres around the trail head to search', { default: SEARCH_RADIUS_METRES })
    .option('--per-metro [count]', 'Trails ranked around each city when demand leaves room', { default: PICKS_PER_METRO })
    .action(async (options: SourceOptions) => {
      const perf = await intro('buddy trails:source-photos')

      const report = await sourceTrailPhotos({
        limit: Math.max(1, Number(options.limit) || DEFAULT_NIGHTLY_LIMIT),
        radiusMetres: Math.max(100, Number(options.radius) || SEARCH_RADIUS_METRES),
        perMetro: Math.max(1, Number(options.perMetro) || PICKS_PER_METRO),
        // Judged on what a visitor is served: curated, approved and uploaded
        // photos are applied on read, so the column alone would re-search
        // trails that already show a real one.
        servedCovers: rows => withBestTrailCovers(rows, 'display'),
        onTrail: (trail, queued, stored, error) => {
          if (error) {
            log.warn(`  ${trail.id}  ${trail.name}: ${error}`)
            return
          }
          const byName = stored?.byName ? ` (${stored.byName} by name)` : ''
          const found = stored?.pending ? `${stored.pending} to review${byName}` : 'nothing names it'
          const refused = stored?.refused ? `, ${stored.refused} refused for licence` : ''
          log.info(`  ${trail.id}  ${trail.name}${trail.state ? ` (${trail.state})` : ''} [${queued.reason}]: ${found}${refused}`)
        },
      })

      log.info('')
      log.info(`  looked up        ${report.searched} of ${report.queued}`)
      log.info(`  with candidates  ${report.withCandidates}`)
      log.info(`  to review        ${report.pending}`)
      log.info(`  found by name    ${report.byName}`)
      log.info(`  licence refused  ${report.refused}`)
      if (report.failed)
        log.warn(`  failed           ${report.failed} (tried again tomorrow)`)
      if (report.stopped)
        log.warn(`  stopped early: ${report.stopped}`)

      await outro(`Queued ${report.pending} photo(s) for review`, { startTime: perf, useSeconds: true })
      process.exit(ExitCode.Success)
    })
}

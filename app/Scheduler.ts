import process from 'node:process'
import { schedule } from '@stacksjs/scheduler'

/**
 * **Scheduler**
 *
 * This is your Scheduler. Because Stacks is fully-typed, you may hover any of the
 * options below and the definitions will be provided. In case you have any
 * questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default function () {
  schedule.command('./buddy territory:ranks')
    .hourly()
    .withoutOverlapping(30)
    .onOneServer()
    .withName('wildloop-territory-ranks')

  // Tomorrow's trip plans, at six in the evening where each was made.
  schedule.command('./buddy plans:remind')
    .hourly()
    .withoutOverlapping(30)
    .onOneServer()
    .withName('wildloop-plan-reminders')

  schedule.command('./buddy territory:decay --apply')
    .at('03:10')
    .setTimeZone('UTC')
    .withoutOverlapping(60)
    .onOneServer()
    .withName('wildloop-territory-decay')

  // A checked, compressed copy of the database every night, seven kept, and
  // off the box when DB_SNAPSHOT_RESTIC_ENV names a restic repository
  // (app/Support/databaseSnapshot.ts). Before the 04:10 repairs, so the copy
  // is of the database they found.
  schedule.command('./buddy db:snapshot --keep 7')
    .at('03:20')
    .setTimeZone('UTC')
    .withoutOverlapping(60)
    .onOneServer()
    .withName('wildloop-db-snapshot')

  schedule.command('./buddy counters:recompute')
    .at('04:10')
    .setTimeZone('UTC')
    .withoutOverlapping(60)
    .onOneServer()
    .withName('wildloop-counter-repair')

  // Trail page views older than ranking or anybody reads (trailViews.ts).
  // Bounded per night, so a backlog drains over several.
  schedule.command('./buddy trails:prune-views')
    .at('04:40')
    .setTimeZone('UTC')
    .withoutOverlapping(30)
    .onOneServer()
    .withName('wildloop-trail-view-prune')

  /*
   * Photo candidates for the trails people open, for a person to review on
   * /admin/photos (#1006). Never a cover by itself: it only writes pending
   * rows (app/Support/trailPhotoQueue.ts).
   *
   * Sixty trails is about a minute and a half of Wikimedia Commons, one
   * request a second with a User-Agent that says who we are, and nothing
   * else of ours calls Commons. Told to slow down twice it stops for the
   * night. A trail looked up is skipped for 90 days, so each night reaches
   * further down the list rather than asking the same questions again.
   * 05:10 UTC, after the 04:40 prune and well before the 09:40 slice.
   */
  schedule.command('./buddy trails:source-photos --limit 60')
    .at('05:10')
    .setTimeZone('UTC')
    .withoutOverlapping(30)
    .onOneServer()
    .withName('wildloop-trail-photo-candidates')

  /*
   * Elevation gain for the catalog, a slice a night (#1003).
   *
   * Nobody was ever going to type this. The command has been on the box since
   * 7a97b7ea and the catalog is still at 0% gain, because shipping a
   * maintenance command deploys the script and runs nothing — so the most-read
   * empty field on every trail page stayed empty, and difficulty stayed graded
   * on length alone (#1004).
   *
   * A slice rather than one pass: measuring 596,556 trails is days of work, and
   * a job that long has nowhere safe to be interrupted. This one does — it
   * selects on `elevation_checked_at`, so each night resumes where the last
   * stopped, and once the catalog is answered it costs one COUNT and exits.
   * The limit is deliberately conservative until the box's own rate is known
   * from the logs; the only measurement we have, 1.2 trails/s, is against the
   * public server over the internet and should be a floor rather than a guess.
   */
  schedule.command('./buddy trails:repair-elevation --limit 10000')
    .at('02:10')
    .setTimeZone('UTC')
    .withoutOverlapping(300)
    .onOneServer()
    .withName('wildloop-trail-elevation')

  /*
   * Place names for the catalog, a slice a night.
   *
   * Most trails came from OpenStreetMap and read only their state —
   * "California" on 76% of a 2,190-trail sample around Los Angeles. The
   * ingest now names a trail after its park or nearest town as it writes it;
   * this names the ones it wrote before.
   *
   * Resumable the same way as the elevation slice: it selects on
   * `location_checked_at`, so each night carries on from the last and a
   * finished catalog costs one indexed COUNT. Unlike that job it needs
   * nothing off the box — the gazetteer and the agency trails are local — so
   * the slice is bounded by the database alone. 50,000 trails ran in 106s on
   * a 600,000-row copy on a laptop; allow the box several times that and the
   * catalog is done in about twelve nights.
   *
   * 09:40 UTC is the small hours across the US (02:40 Pacific), and clear of
   * the 02:10 elevation slice, which can hold the box past 04:00.
   */
  schedule.command('./buddy trails:repair-locations --limit 50000')
    .at('09:40')
    .setTimeZone('UTC')
    .withoutOverlapping(120)
    .onOneServer()
    .withName('wildloop-trail-locations')
}

process.on('SIGINT', () => {
  schedule.gracefulShutdown().then(() => process.exit(0))
})

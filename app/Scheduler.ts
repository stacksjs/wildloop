import process from 'node:process'
import { Schedule, schedule } from '@stacksjs/scheduler'
import { pingHeartbeat, runReported } from './Support/schedulerHeartbeat'

/**
 * **Scheduler**
 *
 * This is your Scheduler. Because Stacks is fully-typed, you may hover any of the
 * options below and the definitions will be provided. In case you have any
 * questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default function () {
  /**
   * The heartbeat StatusHQ watches (see app/Support/schedulerHeartbeat.ts).
   * A callback rather than a command: it runs inside this process, so a ping
   * means this scheduler is alive, and it costs no `./buddy` start every five
   * minutes. Without SCHEDULER_HEARTBEAT_URL (locally, in QA) it is not
   * scheduled at all.
   */
  const heartbeatUrl = process.env.SCHEDULER_HEARTBEAT_URL
  if (heartbeatUrl) {
    new Schedule(async () => { await pingHeartbeat(heartbeatUrl) })
      .everyFiveMinutes()
      .withName('wildloop-heartbeat')
  }

  /**
   * The jobs whose failure should reach somebody: a missed backup, territory
   * that stops decaying, counters that drift, the catalog fold. Each reports
   * to its own StatusHQ monitor when HEARTBEAT_<JOB> holds its ping URL, and
   * runs exactly as `schedule.command` would when it does not.
   */
  const reported = (command: string, env: string) => {
    const url = process.env[env]
    return url ? new Schedule(() => runReported(command, url)) : schedule.command(command)
  }

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

  reported('./buddy territory:decay --apply', 'HEARTBEAT_TERRITORY_DECAY')
    .at('03:10')
    .setTimeZone('UTC')
    .withoutOverlapping(60)
    .onOneServer()
    .withName('wildloop-territory-decay')

  // A checked, compressed copy of the database every night, seven kept, and
  // off the box when DB_SNAPSHOT_RESTIC_ENV names a restic repository
  // (app/Support/databaseSnapshot.ts). Before the 04:10 repairs, so the copy
  // is of the database they found.
  reported('./buddy db:snapshot --keep 7', 'HEARTBEAT_DB_SNAPSHOT')
    .at('03:20')
    .setTimeZone('UTC')
    .withoutOverlapping(60)
    .onOneServer()
    .withName('wildloop-db-snapshot')

  /**
   * Restore the newest off-box snapshot to a scratch file and check it
   * (app/Support/restoreDrill.ts): a backup nobody has restored is a
   * hypothesis. Sundays at 05:40 UTC, after the 03:20 snapshot has landed.
   */
  // onDays() before at(): onDays sets the time to midnight, at() keeps the day.
  reported('./buddy db:restore-drill', 'HEARTBEAT_RESTORE_DRILL')
    .onDays([0])
    .at('05:40')
    .setTimeZone('UTC')
    .withoutOverlapping(120)
    .onOneServer()
    .withName('wildloop-restore-drill')

  reported('./buddy counters:recompute', 'HEARTBEAT_COUNTERS')
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
   * finished catalog costs one indexed COUNT. Unlike that job it mostly needs
   * nothing off the box — the gazetteer and the agency trails are local. Only
   * a trail whose town is more than 10 km off asks our routing server for the
   * heights between, to keep a town across a ridge off its card, and waits
   * for another night when that server does not answer. 50,000 trails ran
   * in 106s on a 600,000-row copy on a laptop; allow the box several times
   * that and the catalog is done in about twelve nights.
   *
   * Migration 201 handed the 30,833 trails a full pass had left naming only
   * their region back to this job, to be asked again under the wider rules
   * (see `betterLocation()`): one night's slice covers them.
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

  /*
   * Way fragments folded into the trails they are pieces of, a slice a night
   * (#1002).
   *
   * The catalog is OpenStreetMap ways, so one trail is often several rows:
   * 35% of 8,368 production rows around Los Angeles, Boulder and Garmisch are
   * a same-named piece of a row they join. This records them in
   * `trail_parts`, which the catalog, search and the sitemap leave out.
   *
   * It walks the names shared by more than one row, carrying on from where
   * the last night stopped (`trail_fold_progress`) and starting again from
   * the first name when it reaches the last, so it never finishes for good:
   * the ingest folds what it writes, and each pass puts right whatever that
   * missed. The slice is in names. On a laptop, a 600,000-row copy built from
   * production rows — pessimistic, since every name in it is 72 times
   * commoner than in production — took 24s for its first whole pass, 5,069
   * names writing 212,124 pieces, and 2.4s per 2,000 names once there was
   * nothing left to change. Allow the box several times that and 25,000
   * names is a few minutes a night.
   *
   * 10:40 UTC, an hour after the location slice and still the small hours
   * across the US (03:40 Pacific). Both rebuild the place suggestions at the
   * end, and an hour keeps the two rebuilds from overlapping.
   */
  reported('./buddy trails:fold-fragments --limit 25000', 'HEARTBEAT_TRAIL_FOLD')
    .at('10:40')
    .setTimeZone('UTC')
    .withoutOverlapping(60)
    .onOneServer()
    .withName('wildloop-trail-fragments')

  /*
   * How much of each route relation is walked along streets, for the ones
   * written before the ingest measured it.
   *
   * A route relation says nothing about what it is walked on, so the
   * Hollywood Walk of Fame — every member a sidewalk — ranked as a 3-mile
   * loop near downtown Los Angeles. Ranking demotes a route that is mostly
   * street once `trail_street_shares` says so, and this fills that in from
   * the members' tags on Overpass.
   *
   * Resumable on the table itself: it asks only about relations with no row,
   * and every relation asked about gets one, so once the catalog is measured
   * it costs one query a night. The catalog's 84,847 relations were measured
   * by hand on 2026-10-05 (566 requests, about five hours at the two a minute
   * Overpass is asked for), and the ingest measures what it writes, so this
   * is the catch-up for anything either missed. 3,000 relations is 20
   * requests, ten minutes.
   *
   * 11:40 UTC, an hour after the fragment slice (04:40 Pacific).
   */
  schedule.command('./buddy trails:measure-streets --limit 3000')
    .at('11:40')
    .setTimeZone('UTC')
    .withoutOverlapping(60)
    .onOneServer()
    .withName('wildloop-trail-streets')
}

process.on('SIGINT', () => {
  schedule.gracefulShutdown().then(() => process.exit(0))
})

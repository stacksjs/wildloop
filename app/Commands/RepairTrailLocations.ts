import type { CLI } from '@stacksjs/types'
import type { LocationWrite } from '../Support/trailLocationRepair'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { db } from '@stacksjs/orm'
import { ExitCode } from '@stacksjs/types'
import { openGazetteer } from '../Support/gazetteer'
import { rebuildSearchPlaces } from '../Support/searchPlaces'
import { locateTrail, writeLocations } from '../Support/trailLocationRepair'

interface RepairOptions {
  batch?: number | string
  limit?: number | string
  country?: string
  dryRun?: boolean
  show?: number | string
}

/** Rows read, decided and written at a time — one write transaction per batch. */
const DEFAULT_BATCH = 500

interface CandidateRow {
  id: number
  name: string
  location: string | null
  state: string | null
  state_name: string | null
  country: string | null
  latitude: number
  longitude: number
  min_lat: number | null
  max_lat: number | null
  min_lng: number | null
  max_lng: number | null
}

/**
 * `buddy trails:repair-locations` — name OSM trails after their park or town.
 *
 * The ingest wrote the region as the location of every OpenStreetMap trail,
 * because OSM records no place for a way: 76% of 2,190 trails sampled around
 * Los Angeles read "California". It now names them as they are written (see
 * `betterLocation()`); this does the same for the ones written before.
 *
 * Shaped like `trails:repair-elevation`, and for the same reasons. It selects
 * on `location_checked_at`, so a stopped run resumes where it stopped and a
 * finished catalog costs one indexed COUNT. Every row it reads is stamped,
 * including the ones it leaves alone — an agency row that already names its
 * park, a trail with no town near enough — so none is asked twice. It refuses
 * to run without the gazetteer, because without one every answer would be
 * "no town" and stamped as such.
 *
 * Each batch is written in one short transaction, after the lookups, so the
 * write lock is held for the writes alone. The search index is kept in step
 * row by row, and the autocomplete place list is rebuilt once at the end,
 * when anything changed: the new places ("Pacific Palisades, CA") belong in
 * it, and one rebuild a night is cheap next to one a batch.
 */
export default function (cli: CLI) {
  cli
    .command('trails:repair-locations', 'Name region-only trails after their park or nearest town')
    .option('--batch [count]', 'Rows decided and written per transaction', { default: DEFAULT_BATCH })
    .option('--limit [count]', 'Stop after this many trails (0 = all)', { default: 0 })
    .option('--country <code>', 'Only trails in this country (e.g. US)')
    .option('--dry-run', 'Decide and report without writing', { default: false })
    .option('--show [count]', 'Print this many of the changes', { default: 0 })
    .action(async (options: RepairOptions) => {
      intro('trails:repair-locations')

      if (!openGazetteer()) {
        log.error('The gazetteer is not built, so no trail could be named after its town.')
        log.info('Build it with `buddy geo:import`, then run this again.')
        process.exitCode = ExitCode.FatalError
        return
      }

      const batchSize = Math.max(1, Number(options.batch ?? DEFAULT_BATCH) || DEFAULT_BATCH)
      const limit = Math.max(0, Number(options.limit ?? 0) || 0)
      const show = Math.max(0, Number(options.show ?? 0) || 0)
      const country = options.country?.trim().toUpperCase() || null

      // Through the partial index on unchecked rows, so this stays cheap on
      // the nights after the catalog is done.
      const countable = await db.sql`
        SELECT COUNT(*) AS total
        FROM trails
        WHERE location_checked_at IS NULL
          AND (${country} IS NULL OR country = ${country})
      `.execute() as Array<{ total: number }>
      const outstanding = Number(countable?.[0]?.total ?? 0)

      if (outstanding === 0) {
        log.success('Nothing to repair — every trail has been asked.')
        outro('Done')
        return
      }

      const target = limit > 0 ? Math.min(limit, outstanding) : outstanding
      log.info(`${target.toLocaleString()} of ${outstanding.toLocaleString()} trail(s) never asked`)
      if (options.dryRun)
        log.warn('Dry run: deciding, but not writing.')

      const started = performance.now()
      let seen = 0
      let written = 0
      let managed = 0
      let towns = 0
      let specific = 0
      let unnamed = 0
      let shown = 0

      // Paged by id rather than OFFSET: stamping the rows being paged over
      // moves them out of the result set.
      let after = 0
      while (seen < target) {
        const take = Math.min(batchSize, target - seen)
        const rows = await db.sql`
          SELECT id, name, location, state, state_name, country, latitude, longitude, min_lat, max_lat, min_lng, max_lng
          FROM trails
          WHERE location_checked_at IS NULL
            AND (${country} IS NULL OR country = ${country})
            AND id > ${after}
          ORDER BY id
          LIMIT ${take}
        `.execute() as CandidateRow[]

        if (!rows || rows.length === 0)
          break

        after = Number(rows[rows.length - 1].id)
        seen += rows.length

        const writes: LocationWrite[] = []
        const settled: number[] = []

        for (const row of rows) {
          const outcome = await locateTrail({
            location: row.location,
            country: row.country,
            state: row.state,
            stateName: row.state_name,
            latitude: Number(row.latitude),
            longitude: Number(row.longitude),
            minLat: row.min_lat,
            maxLat: row.max_lat,
            minLng: row.min_lng,
            maxLng: row.max_lng,
          })

          if (outcome.status === 'better') {
            if (outcome.decision.basis === 'managed')
              managed++
            else
              towns++
            writes.push({ id: Number(row.id), from: String(row.location ?? ''), to: outcome.decision.location })
            if (shown < show) {
              shown++
              log.info(`  ${row.name}: ${row.location || '(none)'} → ${outcome.decision.location}`)
            }
            continue
          }

          if (outcome.status === 'specific')
            specific++
          else if (outcome.status === 'unnamed')
            unnamed++
          else
            continue // The gazetteer went away mid-run: leave the row for the next one.
          settled.push(Number(row.id))
        }

        if (!options.dryRun)
          written += await writeLocations(writes, settled, new Date().toISOString())

        log.info(`  ${seen.toLocaleString()}/${target.toLocaleString()} · ${written.toLocaleString()} renamed`)
      }

      const seconds = (performance.now() - started) / 1000
      if (written > 0 && !options.dryRun) {
        const rebuilt = performance.now()
        if (await rebuildSearchPlaces())
          log.info(`Place suggestions rebuilt in ${((performance.now() - rebuilt) / 1000).toFixed(1)}s`)
      }

      log.info('')
      log.info(`asked     ${seen.toLocaleString()} in ${seconds.toFixed(1)}s (${Math.round(seen / Math.max(seconds, 0.001)).toLocaleString()}/s)`)
      log.info(`park      ${managed.toLocaleString()} (named after the park or forest around them)`)
      log.info(`town      ${towns.toLocaleString()} (named after the nearest town)`)
      log.info(`written   ${written.toLocaleString()}${options.dryRun ? ' (dry run)' : ''}`)
      log.info(`specific  ${specific.toLocaleString()} (already named finer than the region, left alone)`)
      log.info(`unnamed   ${unnamed.toLocaleString()} (nothing near enough to name them by)`)

      outro('Done')
    })
}

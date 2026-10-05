import type { CLI } from '@stacksjs/types'
import process from 'node:process'
import { intro, log, outro } from '@stacksjs/cli'
import { db } from '@stacksjs/orm'
import { ExitCode } from '@stacksjs/types'
import { fetchRelationsByIds } from '../Ingest/sources/osm'
import { recordStreetShares } from '../Support/trailStreetShares'

interface MeasureOptions {
  batch?: number | string
  limit?: number | string
  dryRun?: boolean
  show?: number | string
  measuredBefore?: string
}

/** Relation ids per Overpass request: what `trails:repair-distances` found Overpass answers whole. */
const DEFAULT_BATCH = 150

/** From this share up a route is listed in the report: where `streetAppeal` starts to cost something. */
const REPORTED_SHARE = 0.25

/**
 * `buddy trails:measure-streets` — measure how much of each OSM route
 * relation already in the catalog is walked along streets.
 *
 * The ingest measures a relation as it writes it, from the tags of its
 * member ways (app/Support/streetShare.ts), and ranking demotes one that is
 * mostly sidewalk. This measures the relations written before that, so the
 * Hollywood Walk of Fame stops being offered as a trail near downtown Los
 * Angeles without waiting for the next full re-sync.
 *
 * It records the share alone and leaves the trail rows as they are: the
 * members are fetched for their tags, and rewriting the rows from that would
 * be a re-sync by another name.
 *
 * Resumable by construction: it selects relations with no row in
 * `trail_street_shares`, and every relation it asks about gets one,
 * including a relation Overpass no longer has (with a null share), so a
 * finished catalog costs one query and a re-run never asks twice. When the
 * rule in streetShare.ts changes, `--measured-before <iso>` asks again about
 * every relation measured before then, and overwrites what it finds; pass the
 * same cutoff to every run of one re-measure and it resumes the same way.
 * Shaped like
 * `trails:repair-distances`, and as gentle with Overpass, through the same
 * client.
 */
export default function (cli: CLI) {
  cli
    .command('trails:measure-streets', 'Measure how much of each OSM route relation is walked along streets')
    .option('--batch [count]', 'Relation ids per Overpass request', { default: DEFAULT_BATCH })
    .option('--limit [count]', 'Stop after this many relations (0 = all)', { default: 0 })
    .option('--dry-run', 'Measure and report without writing', { default: false })
    .option('--show [count]', 'Print this many of the routes that are mostly street', { default: 20 })
    .option('--measured-before <iso>', 'Also re-measure relations measured before this ISO time')
    .action(async (options: MeasureOptions) => {
      intro('trails:measure-streets')

      const batchSize = Math.max(1, Number(options.batch ?? DEFAULT_BATCH) || DEFAULT_BATCH)
      const limit = Math.max(0, Number(options.limit ?? 0) || 0)
      const show = Math.max(0, Number(options.show ?? 20) || 0)

      // Nothing sorts before the empty string, so without a cutoff only the
      // relations with no row are asked about.
      let cutoff = ''
      if (options.measuredBefore) {
        const date = new Date(options.measuredBefore)
        if (Number.isNaN(date.getTime())) {
          log.error(`--measured-before is not a date: ${options.measuredBefore}`)
          process.exitCode = ExitCode.FatalError
          return
        }
        cutoff = date.toISOString()
      }

      const rows = await db.sql`
        SELECT source_id FROM trails
        WHERE source = 'osm'
          AND source_id LIKE 'relation/%'
          AND id NOT IN (SELECT trail_id FROM trail_street_shares WHERE measured_at >= ${cutoff})
        ORDER BY id
        LIMIT ${limit > 0 ? limit : -1}
      `.execute() as Array<{ source_id: string }>

      const ids = (rows ?? [])
        .map(row => Number(String(row.source_id).replace('relation/', '')))
        .filter(id => Number.isInteger(id) && id > 0)

      if (ids.length === 0) {
        log.success('Nothing to measure: every relation has a street share.')
        outro('Done')
        return
      }

      const batches = Math.ceil(ids.length / batchSize)
      log.info(`${ids.length.toLocaleString()} relations in ${batches} request(s) of up to ${batchSize}`)
      if (options.dryRun)
        log.warn('Dry run: measuring, but not writing.')

      let measured = 0
      let gone = 0
      let failures = 0
      const streets: Array<{ name: string, sourceId: string, share: number }> = []

      for (let i = 0; i < ids.length; i += batchSize) {
        const asked = ids.slice(i, i + batchSize)
        const batchNumber = Math.floor(i / batchSize) + 1

        try {
          const { trails } = await fetchRelationsByIds(asked)
          const answered = new Set(trails.map(trail => trail.sourceId))

          // Asked about and not answered: deleted upstream, or no longer a
          // route the ingest keeps. Recorded with nothing to go on, so the
          // next run does not ask again.
          const missing = asked
            .map(id => `relation/${id}`)
            .filter(sourceId => !answered.has(sourceId))
            .map(sourceId => ({ sourceId, streetShare: null }))

          for (const trail of trails) {
            if (typeof trail.streetShare === 'number' && trail.streetShare >= REPORTED_SHARE)
              streets.push({ name: trail.name, sourceId: trail.sourceId, share: trail.streetShare })
          }

          if (!options.dryRun)
            await recordStreetShares('osm', [...trails, ...missing])

          measured += trails.length
          gone += missing.length
          log.info(`  batch ${batchNumber}/${batches}: ${trails.length} measured, ${missing.length} gone upstream${options.dryRun ? '' : ', written'}`)
        }
        catch (error) {
          // One bad batch must not end the run: the rest are independent, and
          // the next run picks up whatever this one left unmeasured.
          failures++
          log.warn(`  batch ${batchNumber}/${batches} failed: ${error instanceof Error ? error.message : error}`)
        }
      }

      streets.sort((a, b) => b.share - a.share)
      for (const street of streets.slice(0, show))
        log.info(`  ${Math.round(street.share * 100)}% street  ${street.name}  (${street.sourceId})`)

      log.info('')
      log.info(`measured       ${measured.toLocaleString()}`)
      log.info(`mostly street  ${streets.filter(street => street.share >= 0.5).length.toLocaleString()}`)
      log.info(`gone upstream  ${gone.toLocaleString()}`)

      if (failures > 0) {
        log.warn(`${failures} batch(es) failed — re-run to pick them up.`)
        process.exitCode = ExitCode.FatalError
        return
      }

      outro('Done')
    })
}

import type { CLI } from '@stacksjs/types'
import { intro, log, outro } from '@stacksjs/cli'
import { db } from '@stacksjs/orm'
import { isStockTrailPhoto } from '../../resources/functions/stock-photos'
import { candidatesFrom, commonsGeosearchUrl } from '../Support/trailPhotoCandidates'
import { withBestTrailCovers } from '../Support/trailCovers'

interface CoverageOptions {
  limit?: number | string
  radius?: number | string
  search?: boolean
}

/** How many of the engaged trails to report on by default. */
const DEFAULT_LIMIT = 50

/** Metres around a trail head to look for photographs. */
const DEFAULT_RADIUS = 3000

/** Commons asks for a descriptive agent; an anonymous script gets throttled. */
const USER_AGENT = 'Wildloop/1.0 (https://wildloop.org; trail photo sourcing)'

/** Between Commons calls, so a run of fifty is a polite one. */
const PAUSE_MS = 350

/**
 * `buddy trails:photo-coverage` — which of the trails people open have a real
 * photograph, and what Commons offers for the ones that do not.
 *
 * 0 of 400 trails sampled across production carry a photograph of the trail;
 * they carry Unsplash stock labelled "Illustrative photo" (#1006). Fixing that
 * across 596,556 rows is not a project anybody finishes. Fixing it for the
 * trails somebody actually opens is a short afternoon — and the engaged set is
 * currently about thirty rows, because a trail earns its way in by being rated,
 * reviewed or saved.
 *
 * `--search` adds the legwork: a geosearch around each trail head, narrowed to
 * files whose titles name the trail, with the licence and author carried
 * through. It writes nothing. Proximity says a photograph was taken near a
 * trail, never that it shows one — the same search returns a dogwood flower
 * and a film poster — so the entries in `curatedTrailPhotos.ts` are checked by
 * a person against the Commons file page, and this only shortens that list
 * from "all of Commons" to a handful worth looking at.
 */
export default function (cli: CLI) {
  cli
    .command('trails:photo-coverage', 'Report photo coverage over the trails people actually open')
    .option('--limit [count]', 'How many engaged trails to report on', { default: DEFAULT_LIMIT })
    .option('--radius [metres]', 'Metres around the trail head to search', { default: DEFAULT_RADIUS })
    .option('--search', 'Also look on Wikimedia Commons for candidates', { default: false })
    .action(async (options: CoverageOptions) => {
      intro('trails:photo-coverage')

      const limit = Math.max(1, Number(options.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT)
      const radius = Math.max(100, Number(options.radius ?? DEFAULT_RADIUS) || DEFAULT_RADIUS)

      /*
       * The engaged set: rated, reviewed, or saved by somebody. Ordered so the
       * most-engaged trail is the first one anybody sources a photo for.
       *
       * A plain `rating > 0` would miss a trail somebody saved and nobody has
       * reviewed yet, which is exactly a trail people open.
       */
      const rows = await db.sql`
        SELECT
          t.id, t.name, t.state, t.latitude, t.longitude, t.image,
          t.rating, t.review_count,
          (SELECT COUNT(*) FROM saved_trails s WHERE s.trail_id = t.id) AS saves,
          (SELECT COUNT(*) FROM trail_photos p WHERE p.trail_id = t.id) AS uploads
        FROM trails t
        WHERE t.rating > 0
           OR t.review_count > 0
           OR EXISTS (SELECT 1 FROM saved_trails s WHERE s.trail_id = t.id)
        ORDER BY t.review_count DESC, t.rating DESC, t.id ASC
        LIMIT ${limit}
      `.execute() as Array<Record<string, any>>

      if (!rows?.length) {
        log.warn('No trail is rated, reviewed or saved yet — there is no engaged set to cover.')
        outro('Done')
        return
      }

      /*
       * Judged on what a visitor is actually served, not on the column.
       *
       * A curated or area photograph is applied in the read path rather than
       * stored, so reading `trails.image` straight out of the database reports
       * a trail as having no photo while its page shows one — which is a
       * coverage report that cannot answer the question it exists for.
       */
      const served = await withBestTrailCovers(rows as any[], 'display') as Array<Record<string, any>>

      const missing: Array<Record<string, any>> = []
      let real = 0
      let stock = 0
      let none = 0

      for (const row of served) {
        const image = String(row.image ?? '')
        // An athlete's own upload counts: it is a photograph of the trail by
        // somebody who walked it, which is the thing being counted.
        if (Number(row.uploads) > 0 || (image && !isStockTrailPhoto(image))) {
          real += 1
          continue
        }
        if (image)
          stock += 1
        else none += 1
        missing.push(row)
      }

      const pct = (n: number) => `${Math.round((n / rows.length) * 100)}%`
      log.info('')
      log.info(`  engaged trails      ${rows.length}`)
      log.info(`  with a real photo   ${real}  (${pct(real)})`)
      log.info(`  on stock imagery    ${stock}  (${pct(stock)})`)
      log.info(`  with no photo       ${none}  (${pct(none)})`)

      if (missing.length === 0) {
        log.success('Every engaged trail has a real photograph.')
        outro('Done')
        return
      }

      if (!options.search) {
        log.info('')
        log.info(`  ${missing.length} trail(s) need one. Re-run with --search to see what Commons offers.`)
        for (const row of missing.slice(0, 20))
          log.info(`    ${row.id}  ${row.name}${row.state ? ` (${row.state})` : ''}`)
        outro('Done')
        return
      }

      log.info('')
      log.info(`  Searching Commons within ${radius} m of ${missing.length} trail head(s)…`)

      let withCandidates = 0
      for (const row of missing) {
        const lat = Number(row.latitude)
        const lng = Number(row.longitude)
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          log.info(`    ${row.name}: no coordinates to search around`)
          continue
        }

        let found: ReturnType<typeof candidatesFrom> = []
        try {
          const res = await fetch(commonsGeosearchUrl(lat, lng, radius), {
            headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
          })
          if (!res.ok)
            throw new Error(`Commons returned ${res.status}`)
          found = candidatesFrom(await res.json(), String(row.name ?? ''))
        }
        catch (error) {
          // One trail's lookup failing is not the run failing; the rest are
          // still worth reporting, and the reason is worth saying out loud.
          log.warn(`    ${row.name}: ${error instanceof Error ? error.message : 'search failed'}`)
          continue
        }

        if (found.length === 0) {
          log.info(`    ${row.name}: nothing on Commons names this trail`)
          continue
        }

        withCandidates += 1
        log.info('')
        log.info(`    ${row.name}${row.state ? ` (${row.state})` : ''} — ${found.length} candidate(s)`)
        for (const candidate of found.slice(0, 3)) {
          log.info(`      file     ${candidate.title}`)
          log.info(`      by       ${candidate.credit} · ${candidate.license}`)
          log.info(`      page     ${candidate.pageUrl}`)
        }

        await new Promise(resolve => setTimeout(resolve, PAUSE_MS))
      }

      log.info('')
      log.info(`  ${withCandidates} of ${missing.length} trail(s) have a candidate worth reviewing.`)
      /*
       * Said rather than done. Every entry in `curatedTrailPhotos.ts` was
       * checked against its file page by a person, because a title naming a
       * trail is strong evidence and not proof — and a wrong photograph
       * presented as the trail is worse than the stock one it replaced, which
       * at least says "Illustrative".
       */
      log.success('Nothing was written. Confirm a photo on its Commons page, then add it to app/Support/curatedTrailPhotos.ts.')

      outro('Done')
    })
}

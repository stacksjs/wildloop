import type { CLI } from '@stacksjs/types'
import { intro, log, outro } from '@stacksjs/cli'
import { rebuildSearchPlaces } from '../Support/searchPlaces'
import { fillWholeTrails, foldNames, foldProgress, MAX_NAME_ROWS, nextSharedNames, releaseStaleFolds } from '../Support/trailFolding'

interface FoldOptions {
  batch?: number | string
  limit?: number | string
  dryRun?: boolean
  restart?: boolean
  show?: number | string
  totalsLimit?: number | string
  totalsOnly?: boolean
}

/** Names decided and written at a time — one write transaction per batch. */
const DEFAULT_BATCH = 200

/**
 * Trails a run fills the whole length of before the walk, at most.
 *
 * About ten seconds of reading lines: a 596,556-row copy with 153,153 pieces
 * has 84,641 trails keeping them, and filled all of them in 38 seconds. So
 * the catalog folded before `trail_totals` existed fills over a few nights,
 * or at once with `--totals-only --totals-limit 0`.
 */
const DEFAULT_TOTALS_LIMIT = 20_000

/**
 * `buddy trails:fold-fragments` — stop listing the pieces of a trail as trails.
 *
 * The catalog is imported from OpenStreetMap, where a way is whatever a mapper
 * drew between two junctions, so one trail often arrives as several rows: in
 * 8,368 production rows around Los Angeles, Boulder and Garmisch, 35% are a
 * same-named piece of a row they join (#1002). This finds them and records
 * each in `trail_parts`, which the catalog, search, the sitemap and the
 * region counts leave out. Nothing is deleted, and a piece's page redirects
 * to the trail it is part of. Which rows those are is decided in
 * `app/Support/trailFragments.ts`, where geometry rules: six "Red Trail" rows
 * in six parks stay six trails.
 *
 * Shaped like `trails:repair-locations`. It walks the names shared by more
 * than one row in name order, `--limit` names a run, so a night carries on
 * where the last stopped; the place it is up to is written with each batch
 * in `trail_fold_progress`. Each batch is read and decided first and written
 * in one short transaction, so the write lock is held for the writes alone.
 * The ingest folds the names it writes as it writes them; this catches up
 * the catalog written before, and once it reaches the last name it starts
 * again from the first, so a decision the ingest missed is put right on the
 * next pass. The autocomplete place list is rebuilt once at the end, when
 * anything changed, since its counts leave pieces out.
 *
 * Each trail that keeps pieces also gets its whole length, pieces included,
 * in `trail_totals` (app/Support/wholeTrail.ts): written with the pieces as
 * the walk decides a name, and before the walk for up to `--totals-limit`
 * trails that have pieces and no total — every trail folded before the table
 * existed, and any whose pieces changed since. `--totals-only` does that and
 * stops, which is how the catalog is filled at once.
 */
export default function (cli: CLI) {
  cli
    .command('trails:fold-fragments', 'Fold catalog rows that are pieces of another trail')
    .option('--batch [count]', 'Names decided and written per transaction', { default: DEFAULT_BATCH })
    .option('--limit [count]', 'Stop after this many names (0 = to the end of the catalog)', { default: 0 })
    .option('--dry-run', 'Decide and report without writing', { default: false })
    .option('--restart', 'Start from the first name instead of where the last run stopped', { default: false })
    .option('--show [count]', 'Print this many of the folds', { default: 0 })
    .option('--totals-limit [count]', 'Trails to fill the whole length of before the walk (0 = every one missing)', { default: DEFAULT_TOTALS_LIMIT })
    .option('--totals-only', 'Fill whole lengths, then stop without walking names', { default: false })
    .action(async (options: FoldOptions) => {
      intro('trails:fold-fragments')

      const batchSize = Math.max(1, Number(options.batch ?? DEFAULT_BATCH) || DEFAULT_BATCH)
      const limit = Math.max(0, Number(options.limit ?? 0) || 0)
      const show = Math.max(0, Number(options.show ?? 0) || 0)
      if (options.dryRun)
        log.warn('Dry run: deciding, but not writing.')

      const started = performance.now()

      // Pieces whose trail was renamed or removed since they were folded
      // are listed again before anything else, and decided afresh when the
      // walk reaches their name.
      const released = options.dryRun ? 0 : await releaseStaleFolds()

      // Whole lengths missing for trails that keep pieces, before the walk
      // writes more, so a night always makes headway on the backlog.
      if (!options.dryRun) {
        const totalsLimit = Math.max(0, Number(options.totalsLimit ?? DEFAULT_TOTALS_LIMIT) || 0)
        const filling = performance.now()
        const filled = await fillWholeTrails({ limit: totalsLimit })
        log.info(`totals    ${filled.filled.toLocaleString()} whole trail lengths filled in ${((performance.now() - filling) / 1000).toFixed(1)}s${filled.done ? '' : ', more to fill on the next run'}`)
      }
      if (options.totalsOnly) {
        outro('Done')
        return
      }

      const progress = await foldProgress()
      let after = options.restart ? '' : progress.afterName
      log.info(after ? `Carrying on after "${after}" (pass ${progress.passes + 1})` : `Starting from the first name (pass ${progress.passes + 1})`)

      let names = 0
      let rows = 0
      let pieces = 0
      let folded = 0
      let unfolded = 0
      let skipped = 0
      let shown = 0
      let passed = false

      while (limit === 0 || names < limit) {
        const take = limit > 0 ? Math.min(batchSize, limit - names) : batchSize
        const batch = await nextSharedNames(after, take)
        const last = batch.length < take

        const outcome = await foldNames(batch, {
          dryRun: options.dryRun,
          progress: { afterName: batch[batch.length - 1] ?? after, passed: last },
        })

        names += outcome.names
        rows += outcome.rows
        pieces += outcome.folds.size
        folded += outcome.folded
        unfolded += outcome.unfolded
        skipped += outcome.skipped

        for (const [piece, partOf] of outcome.folds) {
          if (shown >= show)
            break
          shown++
          log.info(`  #${piece} → #${partOf}`)
        }

        if (batch.length > 0)
          after = batch[batch.length - 1]
        if (names > 0 && names % (batchSize * 10) < batch.length)
          log.info(`  ${names.toLocaleString()} names · ${pieces.toLocaleString()} pieces`)

        if (last) {
          passed = true
          break
        }
      }

      const seconds = (performance.now() - started) / 1000
      if ((folded > 0 || unfolded > 0 || released > 0) && !options.dryRun) {
        const rebuilt = performance.now()
        if (await rebuildSearchPlaces())
          log.info(`Place suggestions rebuilt in ${((performance.now() - rebuilt) / 1000).toFixed(1)}s`)
      }

      log.info('')
      log.info(`names     ${names.toLocaleString()} shared names, ${rows.toLocaleString()} rows, in ${seconds.toFixed(1)}s`)
      log.info(`pieces    ${pieces.toLocaleString()} (rows listed under another trail)`)
      log.info(`written   ${folded.toLocaleString()} folded, ${unfolded.toLocaleString()} listed again${options.dryRun ? ' (dry run)' : ''}`)
      if (released > 0)
        log.info(`released  ${released.toLocaleString()} (trail renamed or removed since)`)
      if (skipped > 0)
        log.info(`skipped   ${skipped.toLocaleString()} (names on more than ${MAX_NAME_ROWS.toLocaleString()} rows)`)
      log.info(passed ? 'Reached the last name; the next run starts from the first.' : `Stopped after "${after}"; the next run carries on from there.`)

      outro('Done')
    })
}

import type { CLI } from '@stacksjs/types'
import type { FragmentCandidate } from '../Support/trailFragments'
import { intro, log, outro } from '@stacksjs/cli'
import { db } from '@stacksjs/orm'
import { fragmentClusters, summarise } from '../Support/trailFragments'

interface AnalyzeOptions {
  country?: string
  minGroup?: number | string
  show?: number | string
}

/** How many example clusters to print, so the output stays readable. */
const DEFAULT_SHOW = 15

/**
 * `buddy trails:analyze-fragments` — how much of the catalog is one trail
 * arriving as several rows.
 *
 * The catalog is imported from OpenStreetMap, where a "way" is whatever a
 * mapper drew between two junctions, and the Overpass query asks for named
 * ways *and* route relations — so a real trail often lands as many rows. A
 * sample of 1,200 production trails is 40% under four tenths of a mile, with
 * 23% of rows sharing a name with another row (#1002).
 *
 * That matters beyond tidiness: sourcing a photo for a 0.3-mile unnamed
 * segment is wasted work, and choosing which of six "Red Trail" rows gets it
 * has no answer. Merging first makes every other enrichment cheaper.
 *
 * This command only reads. It answers "what would a merge do" so the numbers
 * can be looked at before anything writes — the merge itself is a separate
 * step, and one that should not be taken on a guess.
 *
 * The deciding is in `app/Support/trailFragments.ts`, which narrows by name
 * and then lets geometry rule: six "Red Trail" rows in six parks stay six
 * trails. That is the whole risk here, and it has its own tests.
 */
export default function (cli: CLI) {
  cli
    .command('trails:analyze-fragments', 'Report which catalog rows are pieces of the same trail')
    .option('--country <code>', 'Only trails in this country (e.g. US)')
    .option('--min-group <count>', 'Ignore names with fewer rows than this', { default: 2 })
    .option('--show <count>', 'Example clusters to print', { default: DEFAULT_SHOW })
    .action(async (options: AnalyzeOptions) => {
      intro('trails:analyze-fragments')

      const country = options.country?.trim().toUpperCase() || null
      const minGroup = Math.max(2, Number(options.minGroup ?? 2) || 2)
      const show = Math.max(0, Number(options.show ?? DEFAULT_SHOW) || DEFAULT_SHOW)

      /*
       * Only rows whose name is shared by another row can possibly be a
       * fragment, so the catalog is narrowed in SQL before any geometry is
       * parsed. Parsing 596,556 lines to discover that most are unique would
       * be the slow way to learn nothing.
       */
      const shared = await db.sql`
        SELECT lower(trim(name)) AS key, COUNT(*) AS rows
        FROM trails
        WHERE name IS NOT NULL AND trim(name) <> ''
          AND geometry IS NOT NULL
          AND (${country} IS NULL OR country = ${country})
        GROUP BY lower(trim(name))
        HAVING COUNT(*) >= ${minGroup}
      `.execute() as Array<{ key: string, rows: number }>

      if (shared.length === 0) {
        log.success('No name is shared by two rows — nothing here is a fragment.')
        outro('Done')
        return
      }

      const sharedRows = shared.reduce((sum, r) => sum + Number(r.rows), 0)
      log.info(`${shared.length.toLocaleString()} names are shared by ${sharedRows.toLocaleString()} rows. Reading their geometry…`)

      const candidates: FragmentCandidate[] = []
      let unreadable = 0

      // One query per name keeps memory flat: the widest group in production
      // is single digits, so this is many small reads rather than one large one.
      for (const { key } of shared) {
        const rows = await db.sql`
          SELECT id, name, country, distance, geometry
          FROM trails
          WHERE lower(trim(name)) = ${key}
            AND geometry IS NOT NULL
            AND (${country} IS NULL OR country = ${country})
        `.execute() as Array<{ id: number, name: string, country: string | null, distance: number | null, geometry: string }>

        for (const row of rows) {
          const geometry = readGeometry(row.geometry)
          if (!geometry) {
            unreadable += 1
            continue
          }
          candidates.push({ id: Number(row.id), name: row.name, country: row.country, distance: Number(row.distance ?? 0), geometry })
        }
      }

      const clusters = fragmentClusters(candidates)
      const totals = summarise(clusters)

      log.info('')
      log.info(`  rows considered      ${candidates.length.toLocaleString()}`)
      log.info(`  physical trails      ${totals.clusters.toLocaleString()}`)
      log.info(`  rows absorbed        ${totals.absorbed.toLocaleString()}`)
      if (unreadable > 0)
        log.info(`  unreadable geometry  ${unreadable.toLocaleString()} (left alone)`)

      // The number that decides whether this is worth doing: rows that shared
      // a name but did NOT join are separate trails the merge correctly
      // refused, and a high count means name alone would have been a disaster.
      const refused = candidates.length - (totals.absorbed + totals.canonical)
      log.info(`  same name, kept apart ${refused.toLocaleString()}`)

      if (show > 0 && clusters.length > 0) {
        log.info('')
        log.info(`  largest ${Math.min(show, clusters.length)}:`)
        for (const cluster of clusters.slice(0, show)) {
          const miles = cluster.totalDistance.toFixed(1)
          log.info(`    ${String(cluster.members.length).padStart(2)} rows  ${miles.padStart(7)} mi  ${cluster.name}  (keep #${cluster.canonical.id})`)
        }
      }

      log.info('')
      const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`
      log.success(`${plural(totals.absorbed, 'row')} would fold into ${plural(totals.clusters, 'trail')}. Nothing was written.`)
      outro('Done')
    })
}

/**
 * The stored line, or null when it cannot be read.
 *
 * Geometry is stored as JSON and the shape has changed over time — a flat list
 * of points, or a list of segments for a trail assembled from relation
 * members. Both are flattened to a single run, because clustering only asks
 * where a row starts and ends.
 */
function readGeometry(raw: string): { lat: number, lng: number }[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return null
  }

  if (!Array.isArray(parsed) || parsed.length === 0)
    return null

  // [[lat, lng], …] or [[[lat, lng], …], …]
  const flat = Array.isArray(parsed[0]) && Array.isArray((parsed as any[])[0][0])
    ? (parsed as any[][]).flat()
    : parsed as any[]

  const points = flat
    .map((point: any) => (Array.isArray(point)
      ? { lat: Number(point[0]), lng: Number(point[1]) }
      : { lat: Number(point?.lat), lng: Number(point?.lng) }))
    .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng))

  return points.length >= 2 ? points : null
}

/**
 * Shared plumbing for the two federal ArcGIS trail layers.
 *
 * Both the Forest Service and the Park Service publish through Esri REST, and
 * both have the same two traits that shape how they are read:
 *
 *  1. A response is capped (2,000 features), and the cap is signalled by
 *     `exceededTransferLimit` rather than an error — so every query has to be
 *     paged until that flag clears or a page comes back short.
 *  2. A named trail is stored as many short segment rows, not one feature. Ten
 *     miles of the Colorado Trail is dozens of rows. Inserting them raw would
 *     fill the catalog with quarter-mile fragments that all share a name.
 *
 * `fetchAllPages` handles the first; the callers group segments by a source
 * specific identity and hand the joined coordinates to one normalizer, which
 * handles the second.
 */

import type { Coordinate } from '../../../resources/functions/geo'
import type { TrailHttpClient } from '../client'
import type { RouteNetwork } from '../../../resources/functions/trail-geometry'
import { haversineDistance } from '../../../resources/functions/geo'
import { routePartsFromSegments } from '../../../resources/functions/trail-geometry'

export interface EsriFeature<T> {
  attributes: T
  geometry?: { paths?: number[][][] }
}

interface EsriQueryResponse<T> {
  features?: Array<EsriFeature<T>>
  exceededTransferLimit?: boolean
  error?: { code: number, message: string, details?: string[] }
}

export interface EsriQuery {
  endpoint: string
  where: string
  outFields: string[]
  returnGeometry?: boolean
  /** Esri caps this server-side; asking for more than the cap is harmless. */
  pageSize?: number
  /** Required for stable paging: without it, page 2 may repeat page 1's rows. */
  orderByFields?: string
  /**
   * Ask the server to collapse duplicates. Enumerating the 350 park units this
   * way is one small request instead of paging all 31,000 trail rows to read
   * one column off them.
   */
  returnDistinctValues?: boolean
}

/**
 * Read every page of an Esri query.
 *
 * Paging is by `resultOffset`, which is only well-defined against a stable
 * sort — hence the mandatory `orderByFields`. The loop stops on the first page
 * that is not full and does not set `exceededTransferLimit`, and refuses to
 * spin forever on a server that keeps claiming there is more.
 */
export async function fetchAllPages<T>(
  client: TrailHttpClient,
  query: EsriQuery,
): Promise<Array<EsriFeature<T>>> {
  const pageSize = query.pageSize ?? 2000
  const collected: Array<EsriFeature<T>> = []

  // 100 pages × 2,000 = 200,000 features, an order of magnitude more than the
  // largest forest or park holds. Hitting it means the server is misreporting.
  const MAX_PAGES = 100

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      where: query.where,
      outFields: query.outFields.join(','),
      returnGeometry: String(query.returnGeometry ?? true),
      outSR: '4326',
      orderByFields: query.orderByFields ?? 'objectid',
      resultOffset: String(page * pageSize),
      resultRecordCount: String(pageSize),
      f: 'json',
    })

    if (query.returnDistinctValues)
      params.set('returnDistinctValues', 'true')

    const url = `${query.endpoint}/query?${params}`
    const response = await client.json<EsriQueryResponse<T>>(url)

    // Esri reports query errors with HTTP 200 and an `error` body, so this is
    // the only place a bad `where` clause surfaces.
    if (response.error)
      throw new Error(`ArcGIS ${response.error.code}: ${response.error.message}`)

    const features = response.features ?? []
    collected.push(...features)

    if (!response.exceededTransferLimit && features.length < pageSize)
      return collected
  }

  return collected
}

/**
 * An Esri polyline as one coordinate run, its paths end to end.
 *
 * Only for deciding which trail a feature belongs to (see `clusterRuns`):
 * that grouping has always been made on this flattened run, and keeping it is
 * what keeps every trail's `#n` source id stable across re-ingests. It is never
 * drawn or measured — a feature's paths can be disjoint, and the hop between
 * them is not trail. `pathsToSegments` is what the geometry is built from.
 */
export function pathsToCoordinates(paths: number[][][] | undefined): Coordinate[] {
  return pathsToSegments(paths).flat()
}

/** An Esri polyline as its separate paths, each a coordinate run. */
export function pathsToSegments(paths: number[][][] | undefined): Coordinate[][] {
  if (!paths)
    return []

  return paths
    .map(path => path
      .filter(point => Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1]))
      .map(([lng, lat]) => ({ lat, lng })))
    .filter(run => run.length > 0)
}

/**
 * The largest gap two segments may have between them and still be considered
 * the same trail, in metres.
 *
 * This decides identity only — which rows are published as one trail. Pieces
 * of one trail are never joined across a gap by a drawn line: anything farther
 * apart than `ROUTE_SNAP_METERS` stays a separate part of the route (see
 * resources/functions/trail-geometry.ts).
 */
const MAX_JOIN_GAP_METERS = 1000

export interface RunCluster<T> {
  /** Where the historical chained route started; orders clusters, and so `#n` ids. */
  anchor: Coordinate
  members: T[]
}

/**
 * Group segment runs into trails: one cluster per *connected* set.
 *
 * Segments arrive in arbitrary order and arbitrary direction — the Forest
 * Service stores each as it was surveyed — so they are grown by proximity:
 * repeatedly take whichever remaining run starts or ends nearest either end of
 * the growing chain.
 *
 * The important part is that it refuses to grow across a real gap. Grouping
 * upstream is imperfect (Forest Service trail numbers are unique per ranger
 * district, not per forest, so number 7 in the Idaho Panhandle is three
 * different trails in three districts), and without this guard "Heart Lake"
 * was reported as a 260-mile trail spanning two degrees of latitude.
 * Disconnected clusters come back separately, and the caller publishes them as
 * separate trails.
 *
 * This is the exact procedure the ingest has always used to decide trail
 * identity, kept so re-ingesting updates the same rows. It USED to also be the
 * drawn line — the chain concatenated, with a straight hop of up to a
 * kilometre wherever the next run did not start where the last one ended, and
 * branching trails zig-zagging between their branches. The line is now built
 * per cluster by `routePartsFromSegments`, which never does that.
 *
 * O(n²) in segments per trail, which is fine: trails have tens of segments.
 */
export function clusterRuns<T>(items: Array<{ run: Coordinate[], member: T }>): Array<RunCluster<T>> {
  const remaining = items.filter(item => item.run.length >= 2)
  if (remaining.length === 0)
    return []

  const clusters: Array<RunCluster<T>> = []

  while (remaining.length > 0) {
    const seed = remaining.shift()!
    // Only the chain's two ends matter for growing it.
    let head = seed.run[0]
    let tail = seed.run[seed.run.length - 1]
    const members = [seed.member]

    // Grow this chain until nothing left is close enough to belong to it.
    // Both ends are eligible: the seed segment is rarely an endpoint of the
    // trail, so growing forward only would strand everything behind it.
    let grew = true
    while (grew && remaining.length > 0) {
      grew = false

      for (const atTail of [true, false]) {
        const anchor = atTail ? tail : head

        let bestIndex = -1
        let bestDistance = Number.POSITIVE_INFINITY
        let bestFlipped = false

        for (let i = 0; i < remaining.length; i++) {
          const run = remaining[i].run
          const toHead = haversineDistance(anchor, run[0])
          const toTail = haversineDistance(anchor, run[run.length - 1])

          if (toHead < bestDistance) {
            bestDistance = toHead
            bestIndex = i
            bestFlipped = false
          }

          if (toTail < bestDistance) {
            bestDistance = toTail
            bestIndex = i
            bestFlipped = true
          }
        }

        if (bestIndex === -1 || bestDistance > MAX_JOIN_GAP_METERS)
          continue

        const [next] = remaining.splice(bestIndex, 1)
        members.push(next.member)
        // The run's far end becomes the chain's new end on that side.
        const far = bestFlipped ? next.run[0] : next.run[next.run.length - 1]
        if (atTail)
          tail = far
        else
          head = far

        grew = true
      }
    }

    clusters.push({ anchor: head, members })
  }

  // Deterministic order, so the ids derived from it are stable between runs
  // even though the upstream row order is not.
  return clusters.sort((a, b) => a.anchor.lat - b.anchor.lat || a.anchor.lng - b.anchor.lng)
}

/**
 * One named group of Esri features → one route network per physical trail.
 *
 * Clustering (identity) runs on each feature's flattened run, exactly as
 * before; the geometry of each cluster is then built from every feature's
 * separate paths.
 */
export function featureRoutes(features: Array<EsriFeature<unknown>>): RouteNetwork[] {
  const clusters = clusterRuns(features.map(feature => ({
    run: pathsToCoordinates(feature.geometry?.paths),
    member: feature,
  })))

  // Not filtered, even when a cluster yields nothing drawable: the caller
  // numbers trails by position here, and dropping one would renumber the rest.
  return clusters.map(cluster =>
    routePartsFromSegments(cluster.members.flatMap(feature => pathsToSegments(feature.geometry?.paths))))
}

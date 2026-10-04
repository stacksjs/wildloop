/**
 * Which catalog rows are pieces of the same trail.
 *
 * The catalog is imported from OpenStreetMap, where a "way" is whatever a
 * mapper drew between two junctions, and the Overpass query asks for named
 * ways *and* route relations — so one real trail often arrives as several
 * rows. A sample of 1,200 production trails across the catalog is 40% under
 * four tenths of a mile, with 23% of rows sharing a name with another row.
 *
 * The obvious rule — same name, merge — is wrong, and wrong in the direction
 * that destroys data. "Red Trail" is six different trails in six different
 * parks; the sample also holds six "Link Trail" rows ranging from 0.12 to
 * 35.87 miles. Name is only a way to find candidates cheaply; geometry
 * decides.
 *
 * So this narrows by name and then hands the decision to `clusterRuns`, the
 * procedure the Forest Service ingest already uses to work out trail identity.
 * It grows a chain by proximity and refuses to cross a real gap, which is what
 * keeps two same-named trails in different places apart — the same guard that
 * stopped "Heart Lake" being reported as one 260-mile trail.
 *
 * Nothing here writes. It answers "which rows are pieces of one trail" and,
 * through `foldPieces`, which of those rows the catalog should stop listing
 * on their own. `trailFolding.ts` is what writes that down.
 */

import type { Coordinate } from '../Ingest/normalize'
import { haversineDistance } from '../../resources/functions/geo'
import { clusterRuns, MAX_JOIN_GAP_METERS } from '../Ingest/sources/arcgis'

/** A catalog row, reduced to what deciding identity needs. */
export interface FragmentCandidate {
  id: number
  name: string
  /** Where the row is, so trails of the same name in two countries never meet. */
  country?: string | null
  distance?: number | null
  /** The drawn line. A row without one cannot be placed, and is left alone. */
  geometry: Coordinate[]
  /** `osm`, `usfs`, `nps` or `manual`. Missing reads as OpenStreetMap. */
  source?: string | null
  /** Reviews people wrote about this row. */
  reviewCount?: number | null
  /** Photos people added to this row. */
  photos?: number | null
  /** Where the row starts. The first point of the line when missing. */
  latitude?: number | null
  longitude?: number | null
}

/** One physical trail, and the rows that are currently pieces of it. */
export interface FragmentCluster {
  /** The name the rows agree on, normalised. */
  name: string
  country: string
  /** Every row in the cluster, canonical first. */
  members: FragmentCandidate[]
  /** The row the others would fold into. */
  canonical: FragmentCandidate
  /** Miles across every member, which is what the merged trail would measure. */
  totalDistance: number
}

/**
 * The name two rows must share to be considered at all.
 *
 * Case and surrounding space are noise from the source. Nothing else is
 * touched: "Red Trail" and "Red Trail Loop" are different names and must stay
 * different, because collapsing them is exactly the over-merge this file is
 * written to avoid.
 */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ')
}

/**
 * The bucket a row is compared within.
 *
 * Country as well as name: "Schillingsweg" is a common German path name, and
 * two of them either side of a border are not one trail. Geometry would refuse
 * to join them anyway — this only saves the comparison.
 */
export function groupKey(candidate: FragmentCandidate): string {
  return `${normalizeName(candidate.name)}\u0000${(candidate.country ?? '').trim().toLowerCase()}`
}

/**
 * How much a row's provenance says it is the trail itself, highest first.
 *
 * The Park Service and the Forest Service draw and name the trails they
 * manage, so their record is the trail as the park knows it; an OpenStreetMap
 * way is a stretch between two junctions. A trail typed in by hand sits
 * between: somebody meant it, but it is not drawn from a survey. It is pinned
 * (`isPinned`) and never folded, so its place here only decides whether
 * pieces fold into it.
 */
const SOURCE_RANK: Record<string, number> = { nps: 3, usfs: 2, manual: 1, osm: 0 }

function sourceRank(candidate: FragmentCandidate): number {
  return SOURCE_RANK[String(candidate.source ?? 'osm').toLowerCase()] ?? 0
}

/**
 * Whether a row carries something people made that only its own page shows.
 *
 * Reviews and photos hang off a trail id, and the trail page is where they
 * are read. Folding such a row would send its page to another trail and take
 * them out of sight, so it is never folded: it stays listed beside the trail
 * it would have joined. A trail typed in by hand is kept for the same reason
 * — somebody meant it to be there.
 */
export function isPinned(candidate: FragmentCandidate): boolean {
  return Number(candidate.reviewCount ?? 0) > 0
    || Number(candidate.photos ?? 0) > 0
    || String(candidate.source ?? '').toLowerCase() === 'manual'
}

/**
 * Which of two rows of one trail is the better one to list, negative when `a`.
 *
 * The park's own record over OpenStreetMap's, then the longest — the row most
 * likely to be the whole route rather than a spur off it, which is where a
 * route relation ingested alongside its member ways lands — then the one
 * people reviewed and photographed. Ties break on the lowest id, so a re-run
 * picks the same row and the fold is repeatable.
 *
 * What people made comes last on purpose. A review on a quarter-mile stub is
 * no reason to list the stub in place of the park's two-mile trail, and it
 * needs no help to stay visible: a pinned row is never folded anyway.
 */
export function compareCanonical(a: FragmentCandidate, b: FragmentCandidate): number {
  return sourceRank(b) - sourceRank(a)
    || Number(b.distance ?? 0) - Number(a.distance ?? 0)
    || Number(b.reviewCount ?? 0) + Number(b.photos ?? 0) - Number(a.reviewCount ?? 0) - Number(a.photos ?? 0)
    || a.id - b.id
}

/** Which row the others fold into. */
function pickCanonical(members: FragmentCandidate[]): FragmentCandidate {
  return [...members].sort(compareCanonical)[0]
}

/**
 * Split rows into the sets geometry could ever join, before `clusterRuns`.
 *
 * `clusterRuns` compares every remaining run with the chain on each step,
 * which is fine for the handful of rows a trail usually has and not for a
 * common name: "Waldweg" is hundreds of rows across Bavaria. Two rows can
 * only ever end up in one cluster through a chain of endpoints each within
 * the join gap of the next, so rows are first grouped by exactly that — on a
 * grid whose cells are wider than the gap — and `clusterRuns` then runs on
 * each group alone.
 *
 * This changes nothing about the answer. A run outside a group is farther
 * than the gap from every end the chain can have, so `clusterRuns` would
 * never have picked it: the clusters are the same, found without comparing
 * Bavaria with itself.
 */
function connectedSets(rows: FragmentCandidate[]): FragmentCandidate[][] {
  if (rows.length < 3)
    return [rows]

  const parent = rows.map((_, i) => i)
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }

  const ends = rows.flatMap((row, i) => [
    { i, point: row.geometry[0] },
    { i, point: row.geometry[row.geometry.length - 1] },
  ])
  // A cell at least the gap wide everywhere in this set, so every pair
  // within the gap sits in the same or a neighbouring cell: a degree of
  // latitude is never less than 110 km, and a degree of longitude shrinks
  // with the cosine of the latitude farthest from the equator.
  const latStep = MAX_JOIN_GAP_METERS / 110_000
  const widest = ends.reduce((most, end) => Math.max(most, Math.abs(end.point.lat)), 0)
  const lngStep = latStep / Math.max(0.05, Math.cos(Math.min(89, widest) * Math.PI / 180))
  const cellOf = (point: Coordinate) => [Math.floor(point.lat / latStep), Math.floor(point.lng / lngStep)]

  const grid = new Map<string, typeof ends>()
  for (const end of ends) {
    const [y, x] = cellOf(end.point)
    const key = `${y}:${x}`
    const cell = grid.get(key)
    if (cell)
      cell.push(end)
    else grid.set(key, [end])
  }

  for (const end of ends) {
    const [y, x] = cellOf(end.point)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        for (const other of grid.get(`${y + dy}:${x + dx}`) ?? []) {
          if (other.i !== end.i && find(other.i) !== find(end.i) && haversineDistance(end.point, other.point) <= MAX_JOIN_GAP_METERS)
            parent[find(other.i)] = find(end.i)
        }
      }
    }
  }

  // Input order kept within each set: `clusterRuns` seeds from the first row.
  const sets = new Map<number, FragmentCandidate[]>()
  rows.forEach((row, i) => {
    const root = find(i)
    const set = sets.get(root)
    if (set)
      set.push(row)
    else sets.set(root, [row])
  })
  return [...sets.values()]
}

/**
 * Group rows into the physical trails they belong to.
 *
 * Only clusters of two or more come back: a row that is already a whole trail
 * is not a fragment and is not this function's business.
 *
 * Rows without geometry are dropped rather than grouped. Merging on a name
 * alone is the failure mode this exists to prevent, and it does not become
 * safe because the coordinates are missing.
 */
export function fragmentClusters(candidates: FragmentCandidate[]): FragmentCluster[] {
  const groups = new Map<string, FragmentCandidate[]>()

  for (const candidate of candidates) {
    if (!candidate.name?.trim() || candidate.geometry.length < 2)
      continue
    const key = groupKey(candidate)
    const group = groups.get(key)
    if (group)
      group.push(candidate)
    else groups.set(key, [candidate])
  }

  const clusters: FragmentCluster[] = []

  for (const [key, group] of groups) {
    // One row under a name is already a whole trail.
    if (group.length < 2)
      continue

    const [name, country] = key.split('\u0000')

    const found = connectedSets(group).flatMap(set => clusterRuns(set.map(member => ({ run: member.geometry, member }))))
    for (const cluster of found) {
      // A cluster of one means geometry refused to join it to anything: a
      // different trail that happens to share a name. That is the answer, not
      // a failure, and it is left exactly as it is.
      if (cluster.members.length < 2)
        continue

      const members = cluster.members
      const canonical = pickCanonical(members)
      clusters.push({
        name,
        country,
        canonical,
        members: [canonical, ...members.filter(m => m.id !== canonical.id)],
        totalDistance: members.reduce((sum, m) => sum + (m.distance ?? 0), 0),
      })
    }
  }

  // Largest first: the merges worth looking at before trusting the rest.
  return clusters.sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name) || a.canonical.id - b.canonical.id)
}

/** What a run would do, for a dry run to print. */
export interface FragmentSummary {
  clusters: number
  /** Rows that would stop appearing in the catalog as separate trails. */
  absorbed: number
  /** Rows the catalog would be left with, from the ones considered. */
  canonical: number
}

export function summarise(clusters: FragmentCluster[]): FragmentSummary {
  return {
    clusters: clusters.length,
    absorbed: clusters.reduce((sum, c) => sum + c.members.length - 1, 0),
    canonical: clusters.length,
  }
}

/**
 * How far apart two rows of one trail may start and still be listed as one.
 *
 * Three miles, the distance near-me ranking already folds same-named rows
 * within (`SAME_TRAIL_MILES` in `trailRanking.ts`), and for the reason it gives
 * there. It matters more here, because a near-me list finds a trail by where
 * it starts: fold the fifth 5-mile section of a long trail into the first and
 * somebody standing at the fifth no longer finds the trail at all. So one
 * long trail can stay a few rows — one per stretch — while the quarter-mile
 * pieces around each of them go.
 */
export const FOLD_RADIUS_MILES = 3

const METERS_PER_MILE = 1609.344

function startOf(candidate: FragmentCandidate): Coordinate {
  const lat = Number(candidate.latitude)
  const lng = Number(candidate.longitude)
  return candidate.latitude != null && candidate.longitude != null && Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat, lng }
    : candidate.geometry[0]
}

/**
 * Which rows to stop listing, and the row each is a piece of.
 *
 * Within each cluster `fragmentClusters` finds, the best row (see
 * `compareCanonical`) is kept; every other row starting within
 * `FOLD_RADIUS_MILES` of a kept row folds into the best such row, and one
 * starting farther away is kept as the trail's next stretch. A row that is
 * pinned (`isPinned`) is never folded, and is kept like any other.
 *
 * A piece always points at a kept row, never at another piece, so following
 * one link is always enough. Rows not in the answer are listed as they are.
 */
export function foldPieces(candidates: FragmentCandidate[]): Map<number, number> {
  const folds = new Map<number, number>()

  for (const cluster of fragmentClusters(candidates)) {
    const kept: FragmentCandidate[] = []
    for (const member of [...cluster.members].sort(compareCanonical)) {
      const start = startOf(member)
      const host = isPinned(member)
        ? undefined
        : kept.find(row => haversineDistance(startOf(row), start) <= FOLD_RADIUS_MILES * METERS_PER_MILE)
      if (host)
        folds.set(member.id, host.id)
      else
        kept.push(member)
    }
  }

  return folds
}

/**
 * The catalog's filter for "not a piece of another trail".
 *
 * Against `trail_parts`, a table of the pieces alone keyed by trail id
 * (migration 0000000190), rather than a column on `trails`. SQLite answers it
 * with one primary-key lookup per row it was already reading, and it cannot
 * steer the planner, so every catalog query keeps the index it used before —
 * and the counts that index covered stay covered. A column would have been
 * read from the row itself, behind the stored line: on a 600,000-row copy that
 * took the catalog's count for one country from 6 ms to 530 ms.
 */
export const NOT_FOLDED_SQL = 'id NOT IN (SELECT trail_id FROM trail_parts)'

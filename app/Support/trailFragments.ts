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
 * Nothing here writes. It answers "which rows are pieces of one trail", and a
 * caller decides what to do about it.
 */

import type { Coordinate } from '../Ingest/normalize'
import { clusterRuns } from '../Ingest/sources/arcgis'

/** A catalog row, reduced to what deciding identity needs. */
export interface FragmentCandidate {
  id: number
  name: string
  /** Where the row is, so trails of the same name in two countries never meet. */
  country?: string | null
  distance?: number | null
  /** The drawn line. A row without one cannot be placed, and is left alone. */
  geometry: Coordinate[]
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
 * Which row the others fold into.
 *
 * The longest, because it is the one most likely to be the whole route rather
 * than a spur off it — a route relation ingested alongside its member ways
 * lands here. Ties break on the lowest id so a re-run picks the same row and
 * the merge is repeatable.
 */
function pickCanonical(members: FragmentCandidate[]): FragmentCandidate {
  return [...members].sort((a, b) => (b.distance ?? 0) - (a.distance ?? 0) || a.id - b.id)[0]
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

    for (const cluster of clusterRuns(group.map(member => ({ run: member.geometry, member })))) {
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
  return clusters.sort((a, b) => b.members.length - a.members.length || a.name.localeCompare(b.name))
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

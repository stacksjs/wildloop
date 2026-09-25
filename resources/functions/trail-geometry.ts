/**
 * Trail geometry: turning a trail's loose pieces into lines that can be drawn,
 * measured and followed without inventing any path.
 *
 * Every upstream hands a trail over in pieces. The Park and Forest Services
 * store a named trail as many short segment rows in no particular order or
 * direction; an OpenStreetMap route relation is a list of member ways that is
 * not reliably ordered either. Many trails are not even a line: Rock Ridge
 * Trail West (Santa Monica Mountains) is six segments meeting at two
 * junctions, a small tree.
 *
 * The old joiners greedily glued each piece to whichever loose end was nearest
 * and bridged gaps of up to a kilometre, so a branching trail came out as one
 * line with straight "teleports" between its pieces. Those straight lines ran
 * across houses and roads on the map, counted toward the trail's distance, and
 * were handed to navigation as if they were walkable.
 *
 * This module builds the pieces into a network instead:
 *
 *  - Endpoints within `ROUTE_SNAP_METERS` are one junction, and an endpoint
 *    that lands on the middle of another piece splits it there (a T-junction).
 *  - Each connected part is walked as ONE continuous line that only ever moves
 *    along real trail: an Euler path where the part allows one (a line, a loop,
 *    a lollipop), otherwise the longest route through it with every side branch
 *    walked out and back.
 *  - Parts farther apart than the snap distance stay separate. Nothing is ever
 *    bridged by more than that.
 *  - Length is the sum of distinct trail, never the walk and never a gap.
 *
 * Storage keeps the long-standing `[[lat,lng],…]` form for a trail that is one
 * part (almost all of them), and `[[[lat,lng],…],…]` — one array per part,
 * longest first — only when a trail is genuinely in several pieces. Readers go
 * through `decodeRouteParts` / `primaryRoutePart`, which accept both.
 *
 * Pure and dependency-free: the ingest uses it on the server and the pages use
 * the decoder in the browser.
 */

import type { Coordinate } from './geo'
import { haversineDistance } from './geo'

/**
 * How far apart two ends may be and still be the same junction, in metres.
 *
 * Surveyed segments abut within a metre or two and OSM ways share nodes, so
 * this only has to absorb digitising slop. It is also the longest straight
 * line a drawn route can ever contain that is not a surveyed piece of trail.
 */
export const ROUTE_SNAP_METERS = 30

/** A stored point: latitude first, as the map layer reads it. */
export type RoutePair = [number, number]

export interface RouteNetwork {
  /** Each connected part as one continuous walk, longest first. */
  parts: Coordinate[][]
  /** Metres of distinct trail in each part, aligned with `parts`. */
  partLengths: number[]
  /** Metres of distinct trail in total: gaps and walked-back spurs excluded. */
  lengthMeters: number
}

interface Edge {
  a: number
  b: number
  coords: Coordinate[]
  length: number
}

interface Step {
  edge: number
  from: number
}

const METERS_PER_DEGREE = 111_320

/**
 * Build a trail's pieces into drawable, walkable parts.
 *
 * Pieces may arrive in any order and either direction, repeated, or touching
 * each other mid-way. The result never contains a step longer than
 * `snapMeters` that is not in the source data.
 */
export function routePartsFromSegments(segments: Coordinate[][], snapMeters = ROUTE_SNAP_METERS): RouteNetwork {
  const pieces = splitAtJunctions(dedupeSegments(segments.map(cleanSegment).filter(s => s.length >= 2)), snapMeters)
  if (pieces.length === 0)
    return { parts: [], partLengths: [], lengthMeters: 0 }

  const { edges, nodePoints } = buildEdges(pieces, snapMeters)
  if (edges.length === 0)
    return { parts: [], partLengths: [], lengthMeters: 0 }

  const components = componentsOf(edges, nodePoints.length)

  const built = components.map((edgeIds) => {
    const line = walkComponent(edges, edgeIds, nodePoints)
    const length = edgeIds.reduce((sum, id) => sum + edges[id].length, 0)
    return { line, length }
  }).filter(part => part.line.length >= 2)

  built.sort((x, y) => y.length - x.length)

  // A fragment shorter than the snap distance is digitising noise, not a
  // piece of trail anyone could walk — unless it is all there is.
  const kept = built.length > 1 ? built.filter((part, index) => index === 0 || part.length >= snapMeters) : built

  return {
    parts: kept.map(part => part.line),
    partLengths: kept.map(part => part.length),
    lengthMeters: kept.reduce((sum, part) => sum + part.length, 0),
  }
}

/** Drop non-finite points and consecutive repeats. */
function cleanSegment(segment: Coordinate[]): Coordinate[] {
  const out: Coordinate[] = []
  for (const point of segment ?? []) {
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lng))
      continue
    const last = out[out.length - 1]
    if (last && last.lat === point.lat && last.lng === point.lng)
      continue
    out.push({ lat: point.lat, lng: point.lng })
  }
  return out
}

/**
 * The same piece listed twice (a relation naming a way for both directions, or
 * a segment row duplicated upstream) is one piece of trail, not two.
 */
function dedupeSegments(segments: Coordinate[][]): Coordinate[][] {
  const seen = new Set<string>()
  const out: Coordinate[][] = []
  for (const segment of segments) {
    const forward = segment.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join(';')
    if (seen.has(forward))
      continue
    const backward = segment.map(p => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).reverse().join(';')
    seen.add(forward)
    seen.add(backward)
    out.push(segment)
  }
  return out
}

/** A coarse spatial hash, so junction finding is not O(points²) on a national trail. */
class PointGrid<T> {
  private readonly cells = new Map<string, Array<{ point: Coordinate, value: T }>>()
  private readonly latCell: number
  private readonly lngCell: number

  constructor(points: Coordinate[], meters: number) {
    const maxAbsLat = points.reduce((max, p) => Math.max(max, Math.abs(p.lat)), 0)
    const cos = Math.max(0.01, Math.cos((Math.min(89, maxAbsLat) * Math.PI) / 180))
    this.latCell = meters / METERS_PER_DEGREE
    this.lngCell = meters / (METERS_PER_DEGREE * cos)
  }

  add(point: Coordinate, value: T): void {
    const key = `${Math.floor(point.lat / this.latCell)}:${Math.floor(point.lng / this.lngCell)}`
    const cell = this.cells.get(key)
    if (cell)
      cell.push({ point, value })
    else
      this.cells.set(key, [{ point, value }])
  }

  /** Every entry within `meters` of `point` (cells are sized so 3×3 covers it). */
  near(point: Coordinate, meters: number): Array<{ value: T, distance: number }> {
    const i = Math.floor(point.lat / this.latCell)
    const j = Math.floor(point.lng / this.lngCell)
    const found: Array<{ value: T, distance: number }> = []
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const cell = this.cells.get(`${i + di}:${j + dj}`)
        if (!cell)
          continue
        for (const entry of cell) {
          const distance = haversineDistance(point, entry.point)
          if (distance <= meters)
            found.push({ value: entry.value, distance })
        }
      }
    }
    return found
  }
}

/**
 * Split pieces where another piece joins them mid-way.
 *
 * Two cases. A piece whose end lands on the middle of another (and on no other
 * end) is a T-junction. And two pieces sharing an interior vertex exactly are
 * a crossing — OSM ways that cross share the node. Without the split, both
 * would be read as unconnected and drawn as separate parts.
 */
function splitAtJunctions(segments: Coordinate[][], snapMeters: number): Coordinate[][] {
  if (segments.length < 2)
    return segments

  const all = segments.flat()
  const grid = new PointGrid<{ s: number, i: number }>(all, snapMeters)
  const exact = new Map<string, Array<{ s: number, i: number }>>()
  const along: number[][] = []

  segments.forEach((segment, s) => {
    const cumulative = [0]
    segment.forEach((point, i) => {
      grid.add(point, { s, i })
      if (i > 0)
        cumulative.push(cumulative[i - 1] + haversineDistance(segment[i - 1], point))
      const key = `${point.lat},${point.lng}`
      const bucket = exact.get(key)
      if (bucket)
        bucket.push({ s, i })
      else
        exact.set(key, [{ s, i }])
    })
    along.push(cumulative)
  })

  const splits = segments.map(() => new Set<number>())
  const isEnd = (s: number, i: number) => i === 0 || i === segments[s].length - 1

  segments.forEach((segment, s) => {
    for (const end of [0, segment.length - 1]) {
      const nearby = grid.near(segment[end], snapMeters)
      // Already meets another piece's end: an ordinary junction, handled by
      // node snapping.
      if (nearby.some(({ value }) => value.s !== s && isEnd(value.s, value.i)))
        continue

      let best: { s: number, i: number, distance: number } | null = null
      for (const { value, distance } of nearby) {
        if (isEnd(value.s, value.i))
          continue
        // A piece curling back onto itself (a lollipop drawn as one way) is a
        // junction too, but its own neighbouring vertices are not.
        if (value.s === s && Math.abs(along[s][value.i] - along[s][end]) <= snapMeters * 3)
          continue
        if (!best || distance < best.distance)
          best = { ...value, distance }
      }
      if (best)
        splits[best.s].add(best.i)
    }
  })

  for (const bucket of exact.values()) {
    if (new Set(bucket.map(entry => entry.s)).size < 2)
      continue
    for (const { s, i } of bucket) {
      if (!isEnd(s, i))
        splits[s].add(i)
    }
  }

  const out: Coordinate[][] = []
  segments.forEach((segment, s) => {
    const cuts = [...splits[s]].sort((x, y) => x - y)
    let start = 0
    for (const cut of cuts) {
      if (cut - start >= 1)
        out.push(segment.slice(start, cut + 1))
      start = cut
    }
    if (segment.length - 1 - start >= 1)
      out.push(segment.slice(start))
  })
  return out
}

/**
 * Snap piece ends into junction nodes and make each piece an edge between two.
 *
 * Leader clustering, not union-find: an end joins the nearest junction whose
 * centre is within the snap distance, or starts a new one. Union-find chains —
 * A near B, B near C — and merged ends 68 m apart on Rocky Oaks Loop into one
 * junction, which the walk then crossed in a straight line. Here every end is
 * within the snap distance of its junction's centre, and `stitch` passes
 * through that centre, so no step it adds is longer than the snap distance.
 */
function buildEdges(pieces: Coordinate[][], snapMeters: number): { edges: Edge[], nodePoints: Coordinate[] } {
  const ends: Coordinate[] = []
  for (const piece of pieces)
    ends.push(piece[0], piece[piece.length - 1])

  const nodePoints: Coordinate[] = []
  const grid = new PointGrid<number>(ends, snapMeters)
  const nodeOfEnd = ends.map((point) => {
    let best = -1
    let bestDistance = Number.POSITIVE_INFINITY
    for (const { value, distance } of grid.near(point, snapMeters)) {
      if (distance < bestDistance || (distance === bestDistance && value < best)) {
        best = value
        bestDistance = distance
      }
    }
    if (best >= 0)
      return best
    nodePoints.push(point)
    grid.add(point, nodePoints.length - 1)
    return nodePoints.length - 1
  })

  const edges: Edge[] = []
  pieces.forEach((coords, p) => {
    const a = nodeOfEnd[p * 2]
    const b = nodeOfEnd[p * 2 + 1]
    let length = 0
    for (let i = 1; i < coords.length; i++)
      length += haversineDistance(coords[i - 1], coords[i])
    // A piece that starts and ends at the same junction and is barely longer
    // than the junction itself is a digitising stub, not a loop.
    if (a === b && length <= snapMeters)
      return
    edges.push({ a, b, coords, length })
  })

  return { edges, nodePoints }
}

function componentsOf(edges: Edge[], nodeCount: number): number[][] {
  const parent = Array.from({ length: nodeCount }, (_, i) => i)
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]
      x = parent[x]
    }
    return x
  }
  for (const edge of edges) {
    const a = find(edge.a)
    const b = find(edge.b)
    if (a !== b)
      parent[a] = b
  }

  const groups = new Map<number, number[]>()
  edges.forEach((edge, id) => {
    const root = find(edge.a)
    const group = groups.get(root)
    if (group)
      group.push(id)
    else
      groups.set(root, [id])
  })
  return [...groups.values()]
}

/**
 * One continuous line over every edge of a connected part.
 *
 * With no or two odd-degree junctions an Euler path exists and covers each
 * edge exactly once — a plain trail, a loop, a lollipop. Otherwise (a trail
 * with side branches) the longest route through the part is the spine, and
 * each branch is walked out and back where it leaves the spine — the way a
 * person on foot would actually cover it.
 */
function walkComponent(edges: Edge[], edgeIds: number[], nodePoints: Coordinate[]): Coordinate[] {
  const adjacency = new Map<number, number[]>()
  const degree = new Map<number, number>()
  for (const id of edgeIds) {
    const { a, b } = edges[id]
    for (const n of a === b ? [a] : [a, b]) {
      const list = adjacency.get(n)
      if (list)
        list.push(id)
      else
        adjacency.set(n, [id])
    }
    degree.set(a, (degree.get(a) ?? 0) + 1)
    degree.set(b, (degree.get(b) ?? 0) + 1)
  }

  const nodes = [...adjacency.keys()]
  const odd = nodes.filter(n => (degree.get(n)! % 2) === 1)

  // Where the source's own first piece starts, when that is a valid start:
  // a single way, or a relation whose members are already in order, keeps its
  // direction rather than being flipped by the tie-break.
  const first = edges[edgeIds[0]]
  const start = odd.length === 0
    ? first.a
    : odd.includes(first.a) ? first.a : odd.includes(first.b) ? first.b : pickStart(edges, adjacency, odd)

  const steps = odd.length === 0 || odd.length === 2
    ? eulerSteps(edges, adjacency, start)
    : spineSteps(edges, adjacency, nodes)

  return stitch(edges, steps, nodePoints)
}

/** The southern-most (then western-most) candidate, so a re-ingest draws the same line. */
function pickStart(edges: Edge[], adjacency: Map<number, number[]>, candidates: number[]): number {
  const at = (n: number): Coordinate => {
    const edge = edges[adjacency.get(n)![0]]
    return edge.a === n ? edge.coords[0] : edge.coords[edge.coords.length - 1]
  }
  return [...candidates].sort((x, y) => at(x).lat - at(y).lat || at(x).lng - at(y).lng)[0]
}

/** Hierholzer's algorithm, iteratively: long relations have thousands of edges. */
function eulerSteps(edges: Edge[], adjacency: Map<number, number[]>, start: number): Step[] {
  const used = new Set<number>()
  const cursor = new Map<number, number>()
  const stack: Array<{ node: number, edge: number }> = [{ node: start, edge: -1 }]
  const popped: Array<{ node: number, edge: number }> = []

  while (stack.length > 0) {
    const top = stack[stack.length - 1]
    const list = adjacency.get(top.node) ?? []
    let i = cursor.get(top.node) ?? 0
    while (i < list.length && used.has(list[i]))
      i++
    cursor.set(top.node, i)

    if (i < list.length) {
      const id = list[i]
      used.add(id)
      const edge = edges[id]
      stack.push({ node: edge.a === top.node ? edge.b : edge.a, edge: id })
    }
    else {
      popped.push(stack.pop()!)
    }
  }

  const path = popped.reverse()
  const steps: Step[] = []
  for (let k = 1; k < path.length; k++)
    steps.push({ edge: path[k].edge, from: path[k - 1].node })
  return steps
}

/** Shortest distances from `source` along the trail, with the edge each node was reached by. */
function dijkstra(edges: Edge[], adjacency: Map<number, number[]>, source: number): { dist: Map<number, number>, via: Map<number, number> } {
  const dist = new Map<number, number>([[source, 0]])
  const via = new Map<number, number>()
  const heap: Array<[number, number]> = [[0, source]]

  const push = (item: [number, number]) => {
    heap.push(item)
    let i = heap.length - 1
    while (i > 0) {
      const up = (i - 1) >> 1
      if (heap[up][0] <= heap[i][0])
        break;
      [heap[up], heap[i]] = [heap[i], heap[up]]
      i = up
    }
  }
  const pop = (): [number, number] => {
    const top = heap[0]
    const last = heap.pop()!
    if (heap.length > 0) {
      heap[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < heap.length && heap[l][0] < heap[m][0])
          m = l
        if (r < heap.length && heap[r][0] < heap[m][0])
          m = r
        if (m === i)
          break;
        [heap[m], heap[i]] = [heap[i], heap[m]]
        i = m
      }
    }
    return top
  }

  while (heap.length > 0) {
    const [d, n] = pop()
    if (d > (dist.get(n) ?? Number.POSITIVE_INFINITY))
      continue
    for (const id of adjacency.get(n) ?? []) {
      const edge = edges[id]
      const next = edge.a === n ? edge.b : edge.a
      const nd = d + edge.length
      if (nd < (dist.get(next) ?? Number.POSITIVE_INFINITY)) {
        dist.set(next, nd)
        via.set(next, id)
        push([nd, next])
      }
    }
  }
  return { dist, via }
}

function farthest(dist: Map<number, number>): number {
  let best = -1
  let bestDistance = -1
  for (const [n, d] of dist) {
    if (d > bestDistance) {
      best = n
      bestDistance = d
    }
  }
  return best
}

/** The spine-and-branches walk for a part with no Euler path. */
function spineSteps(edges: Edge[], adjacency: Map<number, number[]>, nodes: number[]): Step[] {
  const u = farthest(dijkstra(edges, adjacency, nodes[0]).dist)
  const { dist, via } = dijkstra(edges, adjacency, u)
  const v = farthest(dist)

  // Spine from u to v, recovered backwards from v.
  const spineNodes = [v]
  const spineEdges: number[] = []
  for (let n = v; n !== u;) {
    const id = via.get(n)!
    spineEdges.push(id)
    n = edges[id].a === n ? edges[id].b : edges[id].a
    spineNodes.push(n)
  }
  spineNodes.reverse()
  spineEdges.reverse()

  const used = new Set<number>(spineEdges)
  const visited = new Set<number>(spineNodes)
  const steps: Step[] = []

  // Every edge not on the spine is reached from the spine and walked back.
  const excursions = (root: number) => {
    const stack: Array<{ node: number, via: number }> = [{ node: root, via: -1 }]
    while (stack.length > 0) {
      const top = stack[stack.length - 1]
      const next = (adjacency.get(top.node) ?? []).find(id => !used.has(id))
      if (next === undefined) {
        stack.pop()
        if (top.via >= 0)
          steps.push({ edge: top.via, from: top.node })
        continue
      }
      used.add(next)
      const edge = edges[next]
      const other = edge.a === top.node ? edge.b : edge.a
      steps.push({ edge: next, from: top.node })
      if (other === top.node)
        continue
      if (visited.has(other)) {
        // Closes a cycle onto somewhere already covered: step back.
        steps.push({ edge: next, from: other })
        continue
      }
      visited.add(other)
      stack.push({ node: other, via: next })
    }
  }

  spineNodes.forEach((n, i) => {
    excursions(n)
    if (i < spineEdges.length)
      steps.push({ edge: spineEdges[i], from: n })
  })
  return steps
}

/**
 * Lay the steps' coordinates end to end, oriented, without repeating the joins.
 *
 * Where one piece's end and the next piece's start are different points of the
 * same junction, the line passes through the junction's centre between them:
 * each of those two hops is within the snap distance, where the direct line
 * between two ends on opposite sides of a junction need not be.
 */
function stitch(edges: Edge[], steps: Step[], nodePoints: Coordinate[]): Coordinate[] {
  const line: Coordinate[] = []
  const same = (x: Coordinate | undefined, y: Coordinate) => !!x && x.lat === y.lat && x.lng === y.lng
  for (const { edge: id, from } of steps) {
    const edge = edges[id]
    const coords = edge.a === from ? edge.coords : [...edge.coords].reverse()
    const last = line[line.length - 1]
    if (last && !same(last, coords[0])) {
      const junction = nodePoints[from]
      if (!same(last, junction) && !same(coords[0], junction))
        line.push(junction)
    }
    for (const point of coords) {
      if (same(line[line.length - 1], point))
        continue
      line.push(point)
    }
  }
  return line
}

/** Metres along a line. */
export function lineLengthMeters(line: Coordinate[]): number {
  let meters = 0
  for (let i = 1; i < line.length; i++)
    meters += haversineDistance(line[i - 1], line[i])
  return meters
}

/** Storage precision: 5dp is ~1 m. */
function round5(value: number): number {
  return Math.round(value * 1e5) / 1e5
}

/**
 * Storage form of a trail's parts.
 *
 * One part is written as `[[lat,lng],…]`, exactly as every trail always has
 * been, so the common case reads the same to old and new code. Several parts
 * are written as `[[[lat,lng],…],…]`, longest first.
 */
export function encodeRouteParts(parts: Coordinate[][]): string {
  const encoded = parts
    .map((part) => {
      const out: RoutePair[] = []
      for (const point of part) {
        const pair: RoutePair = [round5(point.lat), round5(point.lng)]
        const last = out[out.length - 1]
        if (last && last[0] === pair[0] && last[1] === pair[1])
          continue
        out.push(pair)
      }
      return out
    })
    .filter(part => part.length >= 2)

  if (encoded.length === 0)
    return '[]'
  return JSON.stringify(encoded.length === 1 ? encoded[0] : encoded)
}

function isPair(value: unknown): value is RoutePair {
  return Array.isArray(value) && value.length >= 2
    && typeof value[0] === 'number' && typeof value[1] === 'number'
    && Number.isFinite(value[0]) && Number.isFinite(value[1])
}

/**
 * Read stored geometry — a JSON string or an already-parsed array, one part or
 * several — into parts of `[lat, lng]`. Parts with fewer than two points, and
 * points that are not number pairs, are dropped.
 */
export function decodeRouteParts(raw: unknown): RoutePair[][] {
  let value = raw
  if (typeof value === 'string') {
    if (value.length < 2)
      return []
    try {
      value = JSON.parse(value)
    }
    catch {
      return []
    }
  }
  if (!Array.isArray(value) || value.length === 0)
    return []

  const nested = value.some(item => Array.isArray(item) && Array.isArray(item[0]))
  const parts = (nested ? value : [value]) as unknown[]

  return parts
    .filter(Array.isArray)
    .map(part => (part as unknown[]).filter(isPair).map(p => [p[0], p[1]] as RoutePair))
    .filter(part => part.length >= 2)
}

function pairLength(part: RoutePair[]): number {
  let meters = 0
  for (let i = 1; i < part.length; i++)
    meters += haversineDistance({ lat: part[i - 1][0], lng: part[i - 1][1] }, { lat: part[i][0], lng: part[i][1] })
  return meters
}

/**
 * The trail's main line: its only part, or the longest of several.
 *
 * For readers that need one followable line — navigation, records, offline
 * download, thumbnails. It is never the parts glued together: that glue is the
 * straight line across somebody's back garden this module exists to remove.
 */
export function primaryRoutePart(raw: unknown): RoutePair[] {
  const parts = decodeRouteParts(raw)
  if (parts.length <= 1)
    return parts[0] ?? []
  return parts.reduce((best, part) => (pairLength(part) > pairLength(best) ? part : best))
}

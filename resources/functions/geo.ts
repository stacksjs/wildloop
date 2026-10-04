/**
 * Geographic utility functions for territory management
 * Includes distance calculations, polygon operations, and GPS data processing
 */

export interface Coordinate {
  lat: number
  lng: number
}

export interface GeoJsonPolygon {
  type: 'Polygon'
  coordinates: number[][][]
}

/**
 * Convert degrees to radians
 */
function toRad(deg: number): number {
  return deg * (Math.PI / 180)
}

/**
 * Calculate distance between two points using Haversine formula
 * @returns Distance in meters
 */
export function haversineDistance(point1: Coordinate, point2: Coordinate): number {
  const R = 6371000 // Earth's radius in meters
  const dLat = toRad(point2.lat - point1.lat)
  const dLng = toRad(point2.lng - point1.lng)
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(toRad(point1.lat)) * Math.cos(toRad(point2.lat)) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

/**
 * Check if a GPS track forms a closed loop
 * @param coordinates Array of GPS coordinates
 * @param maxGapMeters Maximum distance between start/end to be considered a loop (default 50m)
 * @param minPoints Minimum points required for a valid loop (default 20)
 */
export function isClosedLoop(
  coordinates: Coordinate[],
  maxGapMeters: number = 50,
  minPoints: number = 20,
): boolean {
  if (coordinates.length < minPoints)
    return false

  const start = coordinates[0]
  const end = coordinates[coordinates.length - 1]
  const distance = haversineDistance(start, end)

  return distance <= maxGapMeters
}

/**
 * The ground a ring encloses, in square metres.
 *
 * "Enclosed" is the non-zero winding rule: a point is inside when the ring
 * goes around it at least once, whichever way and however many times. For a
 * ring that never crosses itself that is the shoelace area, which is exact and
 * is what this returns. A recorded loop does cross itself, though, and the
 * shoelace formula then answers a different question:
 *
 *  - two laps of a park counted the park twice, so a runner could claim (and
 *    take XP for) any multiple of the land they actually circled;
 *  - a figure of eight subtracts one lobe from the other, so a runner who
 *    circled two fields was refused as "too small".
 *
 * Self-crossing rings are measured by scanline instead, row by row, counting
 * the stretches the ring winds around.
 */
export function calculatePolygonArea(coordinates: Coordinate[]): number {
  if (coordinates.length < 3)
    return 0

  // Convert to projected coordinates for accurate area calculation
  const refLat = coordinates[0].lat
  const metersPerDegreeLat = 111132.92
  const metersPerDegreeLng = 111132.92 * Math.cos(toRad(refLat))

  const projected = coordinates.map(c => ({
    x: (c.lng - coordinates[0].lng) * metersPerDegreeLng,
    y: (c.lat - coordinates[0].lat) * metersPerDegreeLat,
  }))

  if (ringSelfIntersects(coordinates))
    return nonZeroWindingArea(projected)

  // Shoelace formula
  let area = 0
  for (let i = 0; i < projected.length; i++) {
    const j = (i + 1) % projected.length
    area += projected[i].x * projected[j].y
    area -= projected[j].x * projected[i].y
  }

  return Math.abs(area / 2)
}

/** The ring as distinct vertices, without a closing repeat of the first. */
function openRing(ring: Coordinate[]): Coordinate[] {
  const open = [...ring]
  while (open.length > 1 && open[0].lat === open[open.length - 1].lat && open[0].lng === open[open.length - 1].lng)
    open.pop()
  return open
}

/** Whether any two non-adjacent edges of a ring cross. */
export function ringSelfIntersects(ring: Coordinate[]): boolean {
  const open = openRing(ring)
  const n = open.length
  if (n < 4)
    return false
  for (let i = 0; i < n; i++) {
    const a1 = open[i]
    const a2 = open[(i + 1) % n]
    for (let k = i + 2; k < n; k++) {
      // The closing edge shares a vertex with the first one.
      if (i === 0 && k === n - 1)
        continue
      if (linesIntersect(a1, a2, open[k], open[(k + 1) % n]))
        return true
    }
  }
  return false
}

/** Non-zero winding area of a projected ring (metres), measured by scanline. */
function nonZeroWindingArea(ring: Array<{ x: number, y: number }>): number {
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const point of ring) {
    minY = Math.min(minY, point.y)
    maxY = Math.max(maxY, point.y)
  }
  const height = maxY - minY
  if (!(height > 0))
    return 0

  const rows = 2048
  const step = height / rows
  let area = 0
  const crossings: Array<{ x: number, direction: number }> = []
  for (let row = 0; row < rows; row++) {
    const y = minY + (row + 0.5) * step
    crossings.length = 0
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % ring.length]
      if ((a.y <= y) === (b.y <= y))
        continue
      crossings.push({ x: a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y), direction: b.y > a.y ? 1 : -1 })
    }
    crossings.sort((left, right) => left.x - right.x)
    let winding = 0
    for (let k = 0; k < crossings.length; k++) {
      if (winding !== 0)
        area += (crossings[k].x - crossings[k - 1].x) * step
      winding += crossings[k].direction
    }
  }
  return area
}

/**
 * Calculate perimeter of a polygon
 * @returns Perimeter in meters
 */
export function calculatePerimeter(coordinates: Coordinate[]): number {
  let perimeter = 0
  for (let i = 0; i < coordinates.length - 1; i++) {
    perimeter += haversineDistance(coordinates[i], coordinates[i + 1])
  }
  // Close the loop if not already closed
  if (coordinates.length > 0) {
    const last = coordinates[coordinates.length - 1]
    const first = coordinates[0]
    if (last.lat !== first.lat || last.lng !== first.lng) {
      perimeter += haversineDistance(last, first)
    }
  }
  return perimeter
}

/**
 * Simplify a GPS track using Douglas-Peucker algorithm
 * @param tolerance Simplification tolerance in degrees (~0.00001 = 1 meter)
 */
export function simplifyTrack(
  coordinates: Coordinate[],
  tolerance: number = 0.00005,
): Coordinate[] {
  if (coordinates.length <= 2)
    return coordinates

  // Find point with max distance from line
  let maxDistance = 0
  let maxIndex = 0

  const start = coordinates[0]
  const end = coordinates[coordinates.length - 1]

  for (let i = 1; i < coordinates.length - 1; i++) {
    const distance = perpendicularDistance(coordinates[i], start, end)
    if (distance > maxDistance) {
      maxDistance = distance
      maxIndex = i
    }
  }

  if (maxDistance > tolerance) {
    const left = simplifyTrack(coordinates.slice(0, maxIndex + 1), tolerance)
    const right = simplifyTrack(coordinates.slice(maxIndex), tolerance)
    return [...left.slice(0, -1), ...right]
  }

  return [start, end]
}

/**
 * Calculate perpendicular distance from a point to a line
 */
function perpendicularDistance(
  point: Coordinate,
  lineStart: Coordinate,
  lineEnd: Coordinate,
): number {
  const dx = lineEnd.lng - lineStart.lng
  const dy = lineEnd.lat - lineStart.lat
  const norm = Math.sqrt(dx * dx + dy * dy)

  if (norm === 0)
    return Math.sqrt((point.lat - lineStart.lat) ** 2 + (point.lng - lineStart.lng) ** 2)

  return Math.abs(
    dy * point.lng - dx * point.lat + lineEnd.lng * lineStart.lat - lineEnd.lat * lineStart.lng,
  ) / norm
}

/**
 * Whether a point is inside a polygon, by the non-zero winding rule.
 *
 * The same rule `calculatePolygonArea` measures by, so a territory is the same
 * ground to every check. Even-odd ray casting agreed for simple rings, but put
 * the middle of a two-lap loop outside it: two crossings is even. A rival's
 * claim drawn inside that land, or a protected home in the middle of it, then
 * went unnoticed.
 */
export function pointInPolygon(point: Coordinate, polygon: Coordinate[]): boolean {
  let winding = 0
  const x = point.lng
  const y = point.lat

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]
    const b = polygon[i]
    // Which side of the edge a→b the point lies on: positive is left.
    const side = (b.lng - a.lng) * (y - a.lat) - (x - a.lng) * (b.lat - a.lat)
    if (a.lat <= y) {
      if (b.lat > y && side > 0)
        winding++
    }
    else if (b.lat <= y && side < 0) {
      winding--
    }
  }

  return winding !== 0
}

/**
 * The shortest distance from a point to a ring's outline, in metres.
 *
 * Measured to the edges, not only the vertices: a simplified loop keeps one
 * vertex at each end of a straight street, so a vertex-only check let an
 * outline run past a protected home a hundred metres away when both ends were
 * further than its radius.
 */
export function distanceToRingMeters(point: Coordinate, ring: Coordinate[]): number {
  if (ring.length === 0)
    return Number.POSITIVE_INFINITY
  if (ring.length === 1)
    return haversineDistance(point, ring[0])

  const metersPerDegreeLat = 111132.92
  const metersPerDegreeLng = 111132.92 * Math.cos(toRad(point.lat))
  const project = (c: Coordinate) => ({ x: (c.lng - point.lng) * metersPerDegreeLng, y: (c.lat - point.lat) * metersPerDegreeLat })

  let nearest = Number.POSITIVE_INFINITY
  for (let i = 0; i < ring.length; i++) {
    const a = project(ring[i])
    const b = project(ring[(i + 1) % ring.length])
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSquared = dx * dx + dy * dy
    // The origin is the point itself; clamp its projection onto the edge.
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared))
    nearest = Math.min(nearest, Math.hypot(a.x + t * dx, a.y + t * dy))
  }
  return nearest
}

/**
 * Check if two line segments intersect
 */
function linesIntersect(
  p1: Coordinate,
  p2: Coordinate,
  p3: Coordinate,
  p4: Coordinate,
): boolean {
  const ccw = (A: Coordinate, B: Coordinate, C: Coordinate): boolean => {
    return (C.lat - A.lat) * (B.lng - A.lng) > (B.lat - A.lat) * (C.lng - A.lng)
  }

  return ccw(p1, p3, p4) !== ccw(p2, p3, p4) && ccw(p1, p2, p3) !== ccw(p1, p2, p4)
}

/**
 * Check if a line segment intersects a polygon
 * Used for conquest detection
 */
export function lineIntersectsPolygon(
  lineStart: Coordinate,
  lineEnd: Coordinate,
  polygon: Coordinate[],
): boolean {
  // Check if either endpoint is inside
  if (pointInPolygon(lineStart, polygon) || pointInPolygon(lineEnd, polygon)) {
    return true
  }

  // Check if line crosses any polygon edge
  for (let i = 0; i < polygon.length - 1; i++) {
    if (linesIntersect(lineStart, lineEnd, polygon[i], polygon[i + 1])) {
      return true
    }
  }

  return false
}

/**
 * Check if a route (array of coordinates) passes through a polygon
 */
export function routeIntersectsPolygon(route: Coordinate[], polygon: Coordinate[]): boolean {
  // Check if any point of the route is inside the polygon
  for (const point of route) {
    if (pointInPolygon(point, polygon)) {
      return true
    }
  }

  // Check if any segment of the route intersects the polygon
  for (let i = 0; i < route.length - 1; i++) {
    if (lineIntersectsPolygon(route[i], route[i + 1], polygon)) {
      return true
    }
  }

  return false
}

/**
 * Calculate bounding box for a polygon
 * @returns String format: "minLat,minLng,maxLat,maxLng"
 */
export function getBoundingBox(coordinates: Coordinate[]): string {
  const lats = coordinates.map(c => c.lat)
  const lngs = coordinates.map(c => c.lng)

  return `${Math.min(...lats)},${Math.min(...lngs)},${Math.max(...lats)},${Math.max(...lngs)}`
}

/**
 * Parse bounding box string back to object
 */
export function parseBoundingBox(bbox: string): { minLat: number, minLng: number, maxLat: number, maxLng: number } {
  const [minLat, minLng, maxLat, maxLng] = bbox.split(',').map(Number)
  return { minLat, minLng, maxLat, maxLng }
}

/**
 * Check if two bounding boxes overlap
 */
export function boundingBoxesOverlap(bbox1: string, bbox2: string): boolean {
  const b1 = parseBoundingBox(bbox1)
  const b2 = parseBoundingBox(bbox2)

  return !(b1.maxLat < b2.minLat || b1.minLat > b2.maxLat
    || b1.maxLng < b2.minLng || b1.minLng > b2.maxLng)
}

/**
 * Whether two polygons overlap (share interior area). Bounding-box quick-reject
 * first, then check intersection in both directions - `routeIntersectsPolygon`
 * catches a vertex inside the other polygon OR an edge crossing, so running it
 * both ways also covers full containment (one polygon entirely inside the other).
 */
export function polygonsOverlap(a: Coordinate[], b: Coordinate[]): boolean {
  if (a.length < 3 || b.length < 3)
    return false
  if (!boundingBoxesOverlap(getBoundingBox(a), getBoundingBox(b)))
    return false
  return routeIntersectsPolygon(a, b) || routeIntersectsPolygon(b, a)
}

/**
 * Calculate centroid of a polygon
 */
export function getCentroid(coordinates: Coordinate[]): Coordinate {
  const lat = coordinates.reduce((sum, c) => sum + c.lat, 0) / coordinates.length
  const lng = coordinates.reduce((sum, c) => sum + c.lng, 0) / coordinates.length
  return { lat, lng }
}

/**
 * Convert coordinate array to GeoJSON Polygon
 */
export function coordinatesToGeoJson(coordinates: Coordinate[]): string {
  // Ensure polygon is closed
  const coords = [...coordinates]
  if (coords.length > 0) {
    const first = coords[0]
    const last = coords[coords.length - 1]
    if (first.lat !== last.lat || first.lng !== last.lng) {
      coords.push(first)
    }
  }

  return JSON.stringify({
    type: 'Polygon',
    coordinates: [coords.map(c => [c.lng, c.lat])],
  })
}

/**
 * Convert GeoJSON Polygon to coordinate array
 */
export function geoJsonToCoordinates(geoJson: string): Coordinate[] {
  const parsed = JSON.parse(geoJson) as GeoJsonPolygon
  return parsed.coordinates[0].map((c: number[]) => ({
    lng: c[0],
    lat: c[1],
  }))
}

/**
 * Find intersection points between a line and a polygon
 * Returns array of intersection points
 */
export function findLinePolygonIntersections(
  lineStart: Coordinate,
  lineEnd: Coordinate,
  polygon: Coordinate[],
): Coordinate[] {
  const intersections: Coordinate[] = []

  for (let i = 0; i < polygon.length - 1; i++) {
    const intersection = lineIntersection(
      lineStart,
      lineEnd,
      polygon[i],
      polygon[i + 1],
    )
    if (intersection) {
      intersections.push(intersection)
    }
  }

  return intersections
}

/**
 * Calculate intersection point of two line segments
 * Returns null if lines don't intersect
 */
function lineIntersection(
  p1: Coordinate,
  p2: Coordinate,
  p3: Coordinate,
  p4: Coordinate,
): Coordinate | null {
  const x1 = p1.lng, y1 = p1.lat
  const x2 = p2.lng, y2 = p2.lat
  const x3 = p3.lng, y3 = p3.lat
  const x4 = p4.lng, y4 = p4.lat

  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
  if (Math.abs(denom) < 1e-10)
    return null

  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom

  if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
    return {
      lng: x1 + t * (x2 - x1),
      lat: y1 + t * (y2 - y1),
    }
  }

  return null
}

/**
 * Split a polygon by a route passing through it
 * This is a simplified version - for MVP, we just identify
 * which portion of the territory the route carved through
 *
 * @returns Array of resulting polygons after the split
 */
/**
 * Segment intersection that also returns the parametric positions: `t` along
 * a1→a2 (the route segment) and `u` along b1→b2 (the polygon edge). Used to
 * order crossings along the route and to place them on the polygon boundary.
 */
function segmentIntersection(
  a1: Coordinate, a2: Coordinate, b1: Coordinate, b2: Coordinate,
): { point: Coordinate, t: number, u: number } | null {
  const x1 = a1.lng, y1 = a1.lat, x2 = a2.lng, y2 = a2.lat
  const x3 = b1.lng, y3 = b1.lat, x4 = b2.lng, y4 = b2.lat
  const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
  if (Math.abs(denom) < 1e-12)
    return null
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1)
    return null
  return { point: { lng: x1 + t * (x2 - x1), lat: y1 + t * (y2 - y1) }, t, u }
}

/**
 * Split a polygon with a route that cuts across it. Single-cut model: the cut
 * runs from where the route FIRST crosses the boundary (entry) to where it LAST
 * crosses (exit), using the real route path between them as the dividing chain,
 * then reconstructs the two pieces by walking the boundary either way around.
 *
 * Correct for convex AND concave polygons, and for routes with >2 crossings
 * (the weaving subpath between entry and exit becomes the cut). Returns
 * `[polygon]` unchanged when there's no clean cut (fewer than 2 crossings, or a
 * degenerate result). A self-intersecting route is out of scope and will fall
 * back to `[polygon]` if it yields a degenerate piece.
 */
export function splitPolygonByRoute(
  polygon: Coordinate[],
  route: Coordinate[],
): Coordinate[][] {
  // Normalize to an open ring of n distinct vertices (drop a closing duplicate).
  const ring = [...polygon]
  while (ring.length > 1) {
    const f = ring[0]
    const l = ring[ring.length - 1]
    if (f.lat === l.lat && f.lng === l.lng)
      ring.pop()
    else
      break
  }
  const n = ring.length
  if (n < 3 || route.length < 2)
    return [polygon]

  // All crossings of the route with the polygon boundary. `pos` = edgeIndex + u
  // (a scalar boundary position); `routeOrder` = routeSegmentIndex + t.
  const crossings: Array<{ point: Coordinate, pos: number, routeOrder: number }> = []
  for (let i = 0; i < route.length - 1; i++) {
    for (let j = 0; j < n; j++) {
      const hit = segmentIntersection(route[i], route[i + 1], ring[j], ring[(j + 1) % n])
      if (hit)
        crossings.push({ point: hit.point, pos: j + hit.u, routeOrder: i + hit.t })
    }
  }
  if (crossings.length < 2)
    return [polygon]

  crossings.sort((a, b) => a.routeOrder - b.routeOrder)
  const entry = crossings[0]
  const exit = crossings[crossings.length - 1]
  if (Math.abs(entry.routeOrder - exit.routeOrder) < 1e-9)
    return [polygon]

  // Cut chain: entry point -> the real route vertices spanned -> exit point.
  const cut: Coordinate[] = [entry.point]
  const lo = Math.floor(entry.routeOrder) + 1
  const hi = Math.floor(exit.routeOrder)
  for (let i = lo; i <= hi; i++)
    cut.push(route[i])
  cut.push(exit.point)

  // Partition the boundary vertices into the two arcs between exit and entry.
  const dist = (p: number, from: number): number => ((p - from) % n + n) % n
  const arcA: Array<{ k: number, d: number }> = [] // exit -> entry, increasing
  const arcB: Array<{ k: number, d: number }> = [] // entry -> exit, increasing
  const spanEntryFromExit = dist(entry.pos, exit.pos)
  for (let k = 0; k < n; k++) {
    const dFromExit = dist(k, exit.pos)
    if (dFromExit > 1e-9 && dFromExit < spanEntryFromExit)
      arcA.push({ k, d: dFromExit })
    else
      arcB.push({ k, d: dist(k, entry.pos) })
  }
  arcA.sort((a, b) => a.d - b.d)
  arcB.sort((a, b) => a.d - b.d)

  // polyA = cut(entry->exit) then boundary exit->entry one way.
  // polyB = cut(entry->exit) then the other boundary arc (reversed so it runs
  // exit->entry).
  const polyA = [...cut, ...arcA.map(x => ring[x.k])]
  const polyB = [...cut, ...arcB.map(x => ring[x.k]).reverse()]

  const close = (p: Coordinate[]): Coordinate[] => {
    if (p.length > 0) {
      const f = p[0]
      const l = p[p.length - 1]
      if (f.lat !== l.lat || f.lng !== l.lng)
        p.push(f)
    }
    return p
  }
  close(polyA)
  close(polyB)

  const result: Coordinate[][] = []
  if (polyA.length >= 4 && calculatePolygonArea(polyA) >= 100)
    result.push(polyA)
  if (polyB.length >= 4 && calculatePolygonArea(polyB) >= 100)
    result.push(polyB)

  return result.length >= 1 ? result : [polygon]
}

/**
 * Generate a loop of coordinates around a center point
 * Useful for seeding and testing
 */
export function generateLoopCoordinates(
  centerLat: number,
  centerLng: number,
  radiusMeters: number,
  points: number = 20,
): Coordinate[] {
  const coords: Coordinate[] = []

  // Convert radius to degrees (approximate)
  const latRadius = radiusMeters / 111000
  const lngRadius = radiusMeters / (111000 * Math.cos(toRad(centerLat)))

  // Generate points with some randomness for realism
  for (let i = 0; i < points; i++) {
    const angle = (2 * Math.PI * i) / points
    const radiusVariation = 0.8 + Math.random() * 0.4 // 80-120% of radius

    coords.push({
      lat: centerLat + latRadius * radiusVariation * Math.sin(angle),
      lng: centerLng + lngRadius * radiusVariation * Math.cos(angle),
    })
  }

  // Close the loop
  coords.push(coords[0])

  return coords
}

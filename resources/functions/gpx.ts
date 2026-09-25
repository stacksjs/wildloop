/**
 * GPX file parsing utilities for extracting GPS coordinates from activities
 */

import type { Coordinate } from './geo'

/**
 * Parse a GPX XML string and extract track coordinates
 * GPX format: https://www.topografix.com/gpx.asp
 */
export function parseGpx(gpxString: string): Coordinate[] {
  const coordinates: Coordinate[] = []

  // Simple regex-based parsing for track points
  // Format: <trkpt lat="37.7749" lon="-122.4194">
  const trkptRegex = /<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)"/g
  let match

  while ((match = trkptRegex.exec(gpxString)) !== null) {
    const lat = Number.parseFloat(match[1])
    const lng = Number.parseFloat(match[2])

    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      coordinates.push({ lat, lng })
    }
  }

  // Also try alternative format: <trkpt lon="..." lat="...">
  const altRegex = /<trkpt\s+lon="([^"]+)"\s+lat="([^"]+)"/g
  while ((match = altRegex.exec(gpxString)) !== null) {
    const lng = Number.parseFloat(match[1])
    const lat = Number.parseFloat(match[2])

    if (!Number.isNaN(lat) && !Number.isNaN(lng)) {
      coordinates.push({ lat, lng })
    }
  }

  return coordinates
}

/**
 * Parse a JSON array of coordinates
 * Format: [[lng, lat], [lng, lat], ...] or [{lat, lng}, {lat, lng}, ...]
 */
export function parseJsonCoordinates(jsonString: string): Coordinate[] {
  try {
    const parsed = JSON.parse(jsonString)

    if (Array.isArray(parsed)) {
      return parsed.map((item) => {
        // Array format: [lng, lat]
        if (Array.isArray(item) && item.length >= 2) {
          return { lng: item[0], lat: item[1] }
        }
        // Object format: {lat, lng}
        if (typeof item === 'object' && 'lat' in item && 'lng' in item) {
          return { lat: Number(item.lat), lng: Number(item.lng) }
        }
        // Object format with lon: {lat, lon}
        if (typeof item === 'object' && 'lat' in item && 'lon' in item) {
          return { lat: Number(item.lat), lng: Number(item.lon) }
        }
        return null
      }).filter((c): c is Coordinate => c !== null)
    }

    return []
  }
  catch {
    return []
  }
}

/**
 * Detect the format of GPS data and parse accordingly
 */
export function parseGpsData(data: string): Coordinate[] {
  if (!data || data.trim() === '')
    return []

  const trimmed = data.trim()

  // Check if it's GPX (XML)
  if (trimmed.startsWith('<?xml') || trimmed.startsWith('<gpx') || trimmed.includes('<trkpt')) {
    return parseGpx(trimmed)
  }

  // Check if it's GeoJSON
  if (trimmed.startsWith('{') && trimmed.includes('"type"')) {
    try {
      const geojson = JSON.parse(trimmed)
      if (geojson.type === 'LineString' && Array.isArray(geojson.coordinates)) {
        return geojson.coordinates.map((c: number[]) => ({ lng: c[0], lat: c[1] }))
      }
      if (geojson.type === 'Polygon' && Array.isArray(geojson.coordinates)) {
        return geojson.coordinates[0].map((c: number[]) => ({ lng: c[0], lat: c[1] }))
      }
    }
    catch {
      // Not valid GeoJSON
    }
  }

  // Check if it's a JSON array
  if (trimmed.startsWith('[')) {
    return parseJsonCoordinates(trimmed)
  }

  return []
}

/**
 * Generate a sample GPX string for a loop around a center point
 * Useful for seeding test data
 */
export function generateSampleLoopGpx(
  centerLat: number,
  centerLng: number,
  radiusMeters: number = 200,
  points: number = 20,
  activityName: string = 'Trail Run',
): string {
  // Generate coordinates
  const latRadius = radiusMeters / 111000
  const lngRadius = radiusMeters / (111000 * Math.cos(centerLat * Math.PI / 180))

  const trackPoints: string[] = []
  const startTime = new Date()

  for (let i = 0; i <= points; i++) {
    const angle = (2 * Math.PI * i) / points
    const radiusVariation = 0.85 + Math.random() * 0.3

    const lat = centerLat + latRadius * radiusVariation * Math.sin(angle)
    const lng = centerLng + lngRadius * radiusVariation * Math.cos(angle)

    const time = new Date(startTime.getTime() + i * 60000) // 1 minute between points

    trackPoints.push(`      <trkpt lat="${lat.toFixed(7)}" lon="${lng.toFixed(7)}">
        <time>${time.toISOString()}</time>
      </trkpt>`)
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Wildloop">
  <metadata>
    <name>${activityName}</name>
    <time>${startTime.toISOString()}</time>
  </metadata>
  <trk>
    <name>${activityName}</name>
    <trkseg>
${trackPoints.join('\n')}
    </trkseg>
  </trk>
</gpx>`
}

/**
 * Generate sample GPS data as JSON for seeding
 */
export function generateSampleLoopJson(
  centerLat: number,
  centerLng: number,
  radiusMeters: number = 200,
  points: number = 20,
): string {
  const latRadius = radiusMeters / 111000
  const lngRadius = radiusMeters / (111000 * Math.cos(centerLat * Math.PI / 180))

  const coordinates: number[][] = []

  for (let i = 0; i <= points; i++) {
    const angle = (2 * Math.PI * i) / points
    const radiusVariation = 0.85 + Math.random() * 0.3

    const lat = centerLat + latRadius * radiusVariation * Math.sin(angle)
    const lng = centerLng + lngRadius * radiusVariation * Math.cos(angle)

    coordinates.push([Number(lng.toFixed(7)), Number(lat.toFixed(7))])
  }

  return JSON.stringify({
    type: 'LineString',
    coordinates,
  })
}

/**
 * Validate that GPS data is sufficient for territory claiming
 */
export function validateGpsDataForClaim(
  data: string,
  minPoints: number = 20,
  maxGapMeters: number = 50,
): { valid: boolean, error?: string, coordinates?: Coordinate[] } {
  const coordinates = parseGpsData(data)

  if (coordinates.length === 0) {
    return { valid: false, error: 'No valid GPS coordinates found in data' }
  }

  if (coordinates.length < minPoints) {
    return { valid: false, error: `Insufficient GPS points: ${coordinates.length} (minimum: ${minPoints})` }
  }

  // Check if it forms a closed loop
  const start = coordinates[0]
  const end = coordinates[coordinates.length - 1]

  // Calculate distance using Haversine formula
  const R = 6371000 // Earth's radius in meters
  const dLat = (end.lat - start.lat) * Math.PI / 180
  const dLng = (end.lng - start.lng) * Math.PI / 180
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(start.lat * Math.PI / 180) * Math.cos(end.lat * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  const distance = R * c

  if (distance > maxGapMeters) {
    return {
      valid: false,
      error: `Route does not form a closed loop: start/end gap is ${distance.toFixed(1)}m (maximum: ${maxGapMeters}m)`,
    }
  }

  return { valid: true, coordinates }
}

/**
 * Basic anti-cheat sanity check on a GPS track (no timestamps available, so a
 * true velocity check isn't possible - that needs per-point times from the
 * recorder). Catches gross fabrication: a teleport-sized jump between
 * consecutive points, or an implausibly short total route.
 */
export function validateTrackRealism(
  coordinates: Coordinate[],
  opts: { maxJumpMeters?: number, minTotalMeters?: number } = {},
): { valid: boolean, error?: string } {
  const maxJumpMeters = opts.maxJumpMeters ?? 2000
  const minTotalMeters = opts.minTotalMeters ?? 100
  if (!coordinates || coordinates.length < 2)
    return { valid: false, error: 'Not enough GPS points' }

  const R = 6371000
  const haversine = (a: Coordinate, b: Coordinate): number => {
    const dLat = (b.lat - a.lat) * Math.PI / 180
    const dLng = (b.lng - a.lng) * Math.PI / 180
    const x = Math.sin(dLat / 2) ** 2
      + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
    return 2 * R * Math.asin(Math.sqrt(x))
  }

  let total = 0
  for (let i = 1; i < coordinates.length; i++) {
    const d = haversine(coordinates[i - 1], coordinates[i])
    if (d > maxJumpMeters)
      return { valid: false, error: `Unrealistic GPS jump of ${(d / 1000).toFixed(1)}km between consecutive points` }
    total += d
  }
  if (total < minTotalMeters)
    return { valid: false, error: `Route too short: ${total.toFixed(0)}m` }

  return { valid: true }
}

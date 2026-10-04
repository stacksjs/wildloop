/**
 * The ground a map is showing, as a centre and a radius a trail search can
 * take — what "Search this area" asks the catalog for.
 */

export interface MapArea {
  lat: number
  lng: number
  /** Miles from the centre to the corner of the view, clamped to what the API searches. */
  radius: number
}

const EARTH_RADIUS_MILES = 3958.8
const MIN_RADIUS_MILES = 1
const MAX_RADIUS_MILES = 300

function haversineMiles(a: { lat: number, lng: number }, b: { lat: number, lng: number }): number {
  const toRad = (deg: number) => deg * Math.PI / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)))
}

/**
 * From the view's centre and one corner. The corner, not the nearest edge:
 * everything on screen falls inside the circle, so a trail visible at the
 * edge of the map is never missing from the list.
 */
export function mapArea(center: { lat: number, lng: number }, corner: { lat: number, lng: number }): MapArea {
  const miles = haversineMiles(center, corner)
  const radius = Math.min(MAX_RADIUS_MILES, Math.max(MIN_RADIUS_MILES, Math.round(miles)))
  return { lat: center.lat, lng: center.lng, radius }
}

/** A latitude/longitude box, as the territory map and its neighbours query by. */
export interface MapBounds {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

function coordinate(value: unknown, limit: number): number | null {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) && Math.abs(number) <= limit ? number : null
}

/**
 * The box a request asked for, or null when it asked for none.
 *
 * Query strings arrive as strings. The territory map tested each corner with
 * `typeof value === 'number'`, which a string never passes, so every viewport
 * the client sent was ignored and the API answered with the first few hundred
 * territories anywhere: the same list for Los Angeles as for London.
 */
export function mapBoundsFromQuery(get: (key: string) => unknown): MapBounds | null {
  const minLat = coordinate(get('min_lat'), 90)
  const minLng = coordinate(get('min_lng'), 180)
  const maxLat = coordinate(get('max_lat'), 90)
  const maxLng = coordinate(get('max_lng'), 180)
  if (minLat === null || minLng === null || maxLat === null || maxLng === null)
    return null
  if (minLat > maxLat || minLng > maxLng)
    return null
  return { minLat, minLng, maxLat, maxLng }
}

/** A box reaching `radiusKm` from a point in each direction, for "near you". */
export function mapBoundsAround(center: { lat: number, lng: number }, radiusKm: number): MapBounds {
  const latSpan = radiusKm / 111.32
  // Longitude degrees shrink towards the poles; the floor keeps the box finite.
  const lngSpan = radiusKm / (111.32 * Math.max(0.01, Math.cos(center.lat * Math.PI / 180)))
  return {
    minLat: Math.max(-90, center.lat - latSpan),
    minLng: Math.max(-180, center.lng - lngSpan),
    maxLat: Math.min(90, center.lat + latSpan),
    maxLng: Math.min(180, center.lng + lngSpan),
  }
}

/** Whether a point lies inside a box. */
export function mapBoundsContain(bounds: MapBounds, lat: number, lng: number): boolean {
  return lat >= bounds.minLat && lat <= bounds.maxLat && lng >= bounds.minLng && lng <= bounds.maxLng
}

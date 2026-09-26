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

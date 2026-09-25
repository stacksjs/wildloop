import { haversineDistance } from '../../resources/functions/geo'
import { boundedString } from '../../resources/functions/validate'

/**
 * The fields a saved route is written from, shared by store and update: a
 * name, the line as `[lat, lng]` pairs (up to 10,000), and the climb. The
 * distance and whether it is a loop are measured here, not taken on trust.
 */
export function readRouteInput(request: { get: (key: string) => unknown }): { columns: Record<string, unknown> } | { error: string } {
  const name = boundedString(request.get('name'), 200)
  const input = request.get('route')
  const route = Array.isArray(input) ? input : []
  const coordinates = route.slice(0, 10000).map((point: any) => ({ lat: Number(point?.[0]), lng: Number(point?.[1]) }))
  const valid = coordinates.length >= 2 && coordinates.every((point: any) => Number.isFinite(point.lat) && Number.isFinite(point.lng) && point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180)
  if (!name || !valid)
    return { error: 'A name and at least two valid route points are required' }
  let distance = 0
  for (let index = 1; index < coordinates.length; index++)
    distance += haversineDistance(coordinates[index - 1], coordinates[index])
  return {
    columns: {
      name,
      route_data: JSON.stringify(coordinates.map((point: any) => [point.lat, point.lng])),
      distance: distance / 1609.344,
      elevation: Math.max(0, Number(request.get('elevation')) || 0),
      closed_loop: haversineDistance(coordinates[0], coordinates[coordinates.length - 1]) <= 50,
    },
  }
}

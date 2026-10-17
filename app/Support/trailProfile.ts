import { resamplePath, ValhallaElevation } from 'ts-maps/services'
import { trailSegmentMiles } from '../../resources/functions/trail-map'
import { primaryRoutePart } from '../../resources/functions/trail-geometry'
import { firstAnswer, valhallaServers } from './routing'

export interface TrailProfilePoint { mi: number, ft: number | null, lat: number, lng: number }

/** Sample the main continuous route. Missing DEM readings stay gaps. */
export async function trailProfile(geometry: unknown): Promise<TrailProfilePoint[]> {
  const line = primaryRoutePart(geometry)
  if (line.length < 2)
    return []
  const samples = resamplePath(line.map(([lat, lng]) => ({ lat, lng })), 160)
  const heights = await firstAnswer(valhallaServers(), async server => {
    const values = await new ValhallaElevation({ baseUrl: server.baseUrl }).getElevations(samples, { signal: AbortSignal.timeout(server.timeoutMs) })
    if (!values.some(value => value !== null))
      throw new Error('Elevation data unavailable')
    return values
  })
  let miles = 0
  return samples.map((point, index) => {
    const previous = samples[index - 1]
    if (previous)
      miles += trailSegmentMiles([previous.lat, previous.lng], [point.lat, point.lng])
    const height = heights[index]
    return { mi: miles, ft: height == null ? null : Math.round(height * 3.28084), lat: point.lat, lng: point.lng }
  })
}

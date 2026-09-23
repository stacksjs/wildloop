import type { LatLngLike } from 'ts-maps/services'
import process from 'node:process'
import { climb, directionsRouter, resamplePath, ValhallaDirections, ValhallaElevation } from 'ts-maps/services'

/**
 * Routing for the route builder, done here rather than in the browser: the
 * page's content policy stays closed to third parties, what people draw is
 * not sent from their device to one, and `VALHALLA_URL` swaps the public
 * FOSSGIS server for a self-hosted Valhalla with no client change.
 */
function valhallaBase(): string | undefined {
  return process.env.VALHALLA_URL || undefined
}

/** How long one routing call may take before the builder draws straight. */
const TIMEOUT_MS = 8000
/** Elevation samples per route: enough for a climb figure, cheap to fetch. */
const CLIMB_SAMPLES = 250

function withTimeout(): AbortSignal {
  return AbortSignal.timeout(TIMEOUT_MS)
}

/** The walking line between two points, along footpaths and trails. */
export async function footpathBetween(from: LatLngLike, to: LatLngLike): Promise<LatLngLike[]> {
  const route = directionsRouter(new ValhallaDirections({ baseUrl: valhallaBase() }), 'walking')
  return route(from, to, withTimeout())
}

const METERS_TO_FEET = 3.28084

/** Ascent and descent along a path, in feet. */
export async function climbAlong(points: LatLngLike[]): Promise<{ gainFt: number, lossFt: number }> {
  const heights = await new ValhallaElevation({ baseUrl: valhallaBase() })
    .getElevations(resamplePath(points, CLIMB_SAMPLES), { signal: withTimeout() })
  const { gain, loss } = climb(heights)
  return { gainFt: Math.round(gain * METERS_TO_FEET), lossFt: Math.round(loss * METERS_TO_FEET) }
}

/** `lat,lng` from a query value, or null. */
export function readPoint(raw: unknown): LatLngLike | null {
  if (typeof raw !== 'string')
    return null
  const [lat, lng] = raw.split(',').map(Number)
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null
}

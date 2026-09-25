import type { LatLngLike } from 'ts-maps/services'
import process from 'node:process'
import { climb, resamplePath, ValhallaElevation } from 'ts-maps/services'
import { decodePolyline } from '../../resources/functions/polyline'

/**
 * Routing for the route builder, done here rather than in the browser: the
 * page's content policy stays closed to third parties, and what people draw
 * is not sent from their device to one.
 *
 * Two Valhalla servers, tried in order:
 * - `VALHALLA_URL` — our own (routing-production), built from OpenStreetMap
 *   for the US and Germany/Austria/Switzerland, where the catalog is.
 * - `VALHALLA_FALLBACK_URL` — the public FOSSGIS server by default, for
 *   everywhere else and for while ours is rebuilding or down. Set it to
 *   `off` to use only our own.
 *
 * Ours gets a short timeout: a leg that cannot be answered there should
 * reach the fallback while the person is still looking at the map.
 */
const PUBLIC_VALHALLA = 'https://valhalla1.openstreetmap.de'
const PRIMARY_TIMEOUT_MS = 3500
const FALLBACK_TIMEOUT_MS = 8000
/** Elevation samples per route: enough for a climb figure, cheap to fetch. */
const CLIMB_SAMPLES = 250
const METERS_TO_FEET = 3.28084

interface Server {
  baseUrl: string
  timeoutMs: number
}

/** The servers to try, in order. Exported for tests. */
export function valhallaServers(env: Record<string, string | undefined> = process.env): Server[] {
  const servers: Server[] = []
  const primary = env.VALHALLA_URL?.trim()
  if (primary)
    servers.push({ baseUrl: primary, timeoutMs: PRIMARY_TIMEOUT_MS })
  const fallback = (env.VALHALLA_FALLBACK_URL ?? PUBLIC_VALHALLA).trim()
  if (fallback && fallback !== 'off' && fallback !== primary)
    servers.push({ baseUrl: fallback, timeoutMs: FALLBACK_TIMEOUT_MS })
  return servers
}

/**
 * Run `attempt` against each server until one answers. Whatever the first
 * one's failure — outside its coverage (Valhalla answers 400), refused while
 * rebuilding, or too slow — the next one gets the same question. The last
 * error is the one reported.
 */
export async function firstAnswer<T>(servers: Server[], attempt: (server: Server) => Promise<T>): Promise<T> {
  let lastError: unknown = new Error('No routing server is configured')
  for (const server of servers) {
    try {
      return await attempt(server)
    }
    catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/**
 * Pedestrian costing tuned for trails rather than pavements.
 *
 * Valhalla's pedestrian defaults are a city walker's: `max_hiking_difficulty`
 * of 1 refuses every path OpenStreetMap grades harder than `sac_scale=hiking`,
 * so a leg drawn along an ordinary mountain trail was routed out to the
 * nearest road instead, and plain `pedestrian` weighs a footway no better
 * than a street with a sidewalk.
 *
 * - `walkway_factor` below 1 makes footways and paths cheaper than streets.
 * - `use_tracks` above the default leans toward unpaved tracks too.
 * - `max_hiking_difficulty` 3 admits `demanding_mountain_hiking` (T3), the
 *   top of what a general trail app should route anyone onto unasked; alpine
 *   routes (T4+) still need the person to draw them point by point.
 */
export const PEDESTRIAN_COSTING = {
  walkway_factor: 0.6,
  sidewalk_factor: 1,
  use_tracks: 0.8,
  max_hiking_difficulty: 3,
} as const

/** The `/route` request for one walking leg. Exported for tests. */
export function footpathRequest(from: LatLngLike, to: LatLngLike): Record<string, unknown> {
  return {
    locations: [{ lat: from.lat, lon: from.lng }, { lat: to.lat, lon: to.lng }],
    costing: 'pedestrian',
    costing_options: { pedestrian: PEDESTRIAN_COSTING },
    directions_type: 'none',
  }
}

/** The line out of a Valhalla `/route` answer (polyline6 per leg). Exported for tests. */
export function footpathFromResponse(body: any): LatLngLike[] {
  const legs: Array<{ shape?: string }> = body?.trip?.legs ?? []
  const line: LatLngLike[] = []
  for (const leg of legs) {
    for (const [lat, lng] of decodePolyline(leg.shape ?? '', 6)) {
      const last = line[line.length - 1]
      if (!last || last.lat !== lat || last.lng !== lng)
        line.push({ lat, lng })
    }
  }
  if (line.length < 2)
    throw new Error('No route between these points')
  return line
}

/** The walking line between two points, along footpaths and trails. */
export async function footpathBetween(from: LatLngLike, to: LatLngLike): Promise<LatLngLike[]> {
  return firstAnswer(valhallaServers(), async (server) => {
    const response = await fetch(`${server.baseUrl.replace(/\/$/, '')}/route`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(footpathRequest(from, to)),
      signal: AbortSignal.timeout(server.timeoutMs),
    })
    // Outside a server's coverage, or no path at all, Valhalla answers 400.
    if (!response.ok)
      throw new Error(`Valhalla request failed: ${response.status} ${response.statusText}`)
    return footpathFromResponse(await response.json())
  })
}

/** Ascent and descent along a path, in feet. */
export async function climbAlong(points: LatLngLike[]): Promise<{ gainFt: number, lossFt: number }> {
  const samples = resamplePath(points, CLIMB_SAMPLES)
  const heights = await firstAnswer(valhallaServers(), async (server) => {
    const found = await new ValhallaElevation({ baseUrl: server.baseUrl })
      .getElevations(samples, { signal: AbortSignal.timeout(server.timeoutMs) })
    // Outside a server's elevation data every height comes back null; ask
    // the next server rather than report a flat route.
    if (found.length && found.every(h => h === null))
      throw new Error('No elevation data here')
    return found
  })
  const { gain, loss } = climb(heights)
  return { gainFt: Math.round(gain * METERS_TO_FEET), lossFt: Math.round(loss * METERS_TO_FEET) }
}

/** `lat,lng` from a query value, or null. */
export function readPoint(raw: unknown): { lat: number, lng: number } | null {
  if (typeof raw !== 'string')
    return null
  const [lat, lng] = raw.split(',').map(Number)
  return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null
}

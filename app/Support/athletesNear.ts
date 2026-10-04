import { placeOfText } from './placeText'
import { milesBetween } from './trailRanking'

/** Within this of a place, an athlete counts as local to it. */
export const NEAR_MILES = 60

export interface Origin {
  lat: number
  lng: number
}

/**
 * A place a request asks about, from `?lat=&lng=`, or null.
 *
 * Rounded to two decimals — about a kilometre — so a "near" question is
 * always a town-sized one, whatever precision the caller sent.
 */
export function readOrigin(request: { get: (key: string) => any }): Origin | null {
  const lat = Number(request.get('lat'))
  const lng = Number(request.get('lng'))
  if (request.get('lat') == null || request.get('lng') == null || !Number.isFinite(lat) || !Number.isFinite(lng)
    || Math.abs(lat) > 90 || Math.abs(lng) > 180)
    return null
  return { lat: Math.round(lat * 100) / 100, lng: Math.round(lng * 100) / 100 }
}

/** Every athlete with a profile town, and only the two columns the test needs. */
export const PROFILE_TOWNS_SQL = 'SELECT id, location FROM users WHERE location IS NOT NULL'

/**
 * The ids of the athletes local to a place. Reads every profile town — a
 * narrow read, and the gazetteer answer for each town is remembered — and
 * leaves the rest of the user row alone.
 */
export async function athletesLivingNear(
  run: (sql: string) => Promise<any[]>,
  origin: Origin,
  isNear: (profileLocation: unknown, origin: Origin) => boolean = livesNear,
): Promise<number[]> {
  const rows = ((await run(PROFILE_TOWNS_SQL)) ?? []) as Array<{ id: number, location: unknown }>
  return rows.filter(row => isNear(row.location, origin)).map(row => Number(row.id))
}

/**
 * Whether an athlete is local to a place, by the town on their public profile.
 *
 * The profile town is the only location used, deliberately. Where somebody's
 * runs start is masked on every public route, and a "near" answer computed
 * from it could be probed from point after point until it gave away where
 * they run. The town is something they chose to publish.
 */
export function livesNear(profileLocation: unknown, origin: Origin, miles = NEAR_MILES): boolean {
  const town = placeOfText(profileLocation)
  return town !== null && milesBetween(origin, town.lat, town.lng) <= miles
}

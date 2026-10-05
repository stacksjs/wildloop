/**
 * Where a "near me" list is asked about, rounded so neighbours share it.
 *
 * A trail list near somebody can be kept at Cloudflare's edge, but only under
 * its exact URL. Coordinates from the phone's GPS differ in the sixth decimal
 * from one person to the next, so every one of them was a URL nobody else
 * would ever ask for, and the edge never hit. Two decimals is about a kilometre
 * (1.1 km of latitude, 0.9 km of longitude in Los Angeles): everyone in the
 * same neighbourhood asks the same question.
 *
 * What a kilometre costs, against a 25-mile search: a trail on the very edge
 * of the box can fall in or out, and two trails within a kilometre of each
 * other can swap places in "closest". The distances shown are not affected:
 * the page recomputes each one from the precise location it still holds
 * (`milesFromOrigin`), so "0.4 mi away" stays true for the person reading it.
 */

/** Decimal places kept. Two is ~1 km; three would be ~110 m and share almost nothing. */
export const SHARED_ORIGIN_DECIMALS = 2

/** A coordinate rounded for a shareable request. */
export function shareableCoordinate(value: number): number {
  const factor = 10 ** SHARED_ORIGIN_DECIMALS
  // `+ 0` folds -0 into 0, so a point on the meridian has one spelling.
  return Math.round(value * factor) / factor + 0
}

/** Miles per degree of latitude, the figure the server ranks with. */
const MILES_PER_DEGREE = 69

/**
 * Miles from the visitor to a trailhead, the way the server measures it
 * (`milesBetween` in app/Support/trailRanking.ts): flat-earth, which at the
 * radii a "near me" list covers is off by less than the rounding of its label.
 * One decimal, as the API sends it.
 */
export function milesFromOrigin(origin: { lat: number, lng: number }, lat: number, lng: number): number {
  const dLat = (lat - origin.lat) * MILES_PER_DEGREE
  const dLng = (lng - origin.lng) * MILES_PER_DEGREE * Math.cos((origin.lat * Math.PI) / 180)
  return Math.round(Math.sqrt(dLat * dLat + dLng * dLng) * 10) / 10
}

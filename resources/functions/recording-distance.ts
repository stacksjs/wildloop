/**
 * How far a recording has actually travelled.
 *
 * A GPS fix is a guess with a radius, and the radius does not shrink when you
 * stand still. Summing the gap between every consecutive fix therefore charges
 * the athlete for the receiver's own wander: at one fix a second, standing
 * still accrues somewhere between one and nine phantom miles an hour depending
 * on how correlated the drift is. A fifty-mile ultra with three quarters of an
 * hour of aid stations and regroups lands three to seven miles long, and the
 * athlete has no way to tell which miles were real.
 *
 * The obvious guard makes it worse. Refusing steps shorter than the accuracy
 * radius sounds right until you notice that at one hertz a walker covers about
 * 1.4 metres between fixes and a five metre radius is normal — so a per-step
 * floor discards the whole of a slow climb and reports an ultra short. Under-
 * counting somebody's fifty miles is a worse failure than over-counting it.
 *
 * So distance is measured between *anchors* rather than between fixes. The
 * anchor stays put while the receiver wanders inside its own noise, and jumps
 * to the new fix the moment the displacement is too large to be noise — adding
 * the whole distance from the old anchor, not a smoothed fraction of it. A
 * walker still travels: the anchor simply moves in one stride rather than five,
 * and the total is right either way.
 */

export type LatLng = [number, number]

const EARTH_RADIUS_MILES = 3958.8
const METRES_PER_MILE = 1609.344

/**
 * The radius beyond which a fix is not worth believing at all.
 *
 * A reading this vague is usually a cold start, a tunnel, or a phone deciding
 * it is somewhere in the next valley. Its own reported radius says the position
 * could be anywhere in a area larger than most of the places a trail goes, so
 * it neither moves the anchor nor draws a line.
 */
export const MAX_TRUSTED_ACCURACY_M = 100

/**
 * The smallest displacement treated as travel when the device says nothing
 * about its accuracy.
 *
 * Desktop browsers and some WebViews report `null`. Ten metres is comfortably
 * past ordinary jitter and still under two seconds of running, so a real move
 * is never held up for long.
 */
export const DEFAULT_FLOOR_M = 10

/**
 * How far past the reported radius a fix has to be before it counts as travel.
 *
 * One radius, not two: the radius already describes where the receiver thinks
 * it might be, and doubling it would start discarding real movement on a good
 * day. Floored so an optimistic radius of one metre cannot reintroduce the
 * problem this exists to solve.
 */
export function stepFloorMetres(accuracy: number | null | undefined): number {
  if (accuracy == null || !Number.isFinite(accuracy) || accuracy < 0)
    return DEFAULT_FLOOR_M
  return Math.max(DEFAULT_FLOOR_M, accuracy)
}

/** Great-circle distance in miles. Matches the recorder's own haversine. */
export function haversineMiles(a: LatLng, b: LatLng): number {
  const dLat = (b[0] - a[0]) * Math.PI / 180
  const dLng = (b[1] - a[1]) * Math.PI / 180
  const lat1 = a[0] * Math.PI / 180
  const lat2 = b[0] * Math.PI / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(h))
}

/** What the accumulator remembers between fixes. */
export interface DistanceAnchor {
  /** The last position believed to be where the athlete actually was. */
  point: LatLng | null
  /** Miles accepted so far. */
  miles: number
}

export interface StepResult extends DistanceAnchor {
  /** Miles this fix added, for a caller that wants to know. */
  added: number
  /** Whether the anchor moved, i.e. the fix was treated as travel. */
  moved: boolean
}

export function emptyAnchor(): DistanceAnchor {
  return { point: null, miles: 0 }
}

/**
 * Fold one fix into the running total.
 *
 * Returns a new anchor rather than mutating, so a caller can replay a stored
 * track through the same rule that produced it live and get the same number.
 */
export function step(anchor: DistanceAnchor, point: LatLng, accuracy: number | null | undefined): StepResult {
  // Too vague to believe. Not travel, and not a new anchor either: accepting it
  // would move the reference to a place the device itself doubts.
  if (accuracy != null && Number.isFinite(accuracy) && accuracy > MAX_TRUSTED_ACCURACY_M)
    return { ...anchor, added: 0, moved: false }

  // The first believable fix is where the effort starts. No distance yet.
  if (!anchor.point)
    return { point: point, miles: anchor.miles, added: 0, moved: true }

  const miles = haversineMiles(anchor.point, point)
  const metres = miles * METRES_PER_MILE

  // Inside the noise: the athlete has not demonstrably gone anywhere, so the
  // anchor stays where it is. Crucially the fix is NOT adopted — otherwise the
  // reference would drift with the receiver and the floor would never be met.
  if (metres < stepFloorMetres(accuracy))
    return { ...anchor, added: 0, moved: false }

  return { point, miles: anchor.miles + miles, added: miles, moved: true }
}

/**
 * Total a stored track with the same rule, for recomputing an activity whose
 * distance was recorded before this existed.
 */
export function totalMiles(samples: Array<{ lat: number, lng: number, accuracy?: number | null }>): number {
  let anchor = emptyAnchor()
  for (const sample of samples) {
    if (!Number.isFinite(sample.lat) || !Number.isFinite(sample.lng))
      continue
    anchor = step(anchor, [sample.lat, sample.lng], sample.accuracy ?? null)
  }
  return anchor.miles
}

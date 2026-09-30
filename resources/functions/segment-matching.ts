/**
 * Whether a recorded activity ran a segment, and how long it took.
 *
 * A segment is a named stretch of trail somebody drew — a climb, a descent, a
 * sprint — and the whole feature rests on this one question. Everything else,
 * the leaderboard and the table on the trail page, is bookkeeping on top of the
 * answer.
 *
 * The naive version is to look for the athlete near the start and later near
 * the end, and time the gap. That accepts somebody who ran a completely
 * different route between the same two points, and it is how leaderboards fill
 * up with times nobody could have run. So the track has to be shown to have
 * followed the whole segment, in order: every point of the segment needs a
 * point of the track near it, and those track points have to advance as the
 * segment advances.
 *
 * That ordering requirement is also what makes a descent not count as the
 * climb. The same ground travelled the other way visits the segment's points
 * in reverse, so the progression fails and no effort is recorded — which is
 * correct, and is why a segment has a direction at all.
 */

const EARTH_RADIUS_METRES = 6_371_000

/**
 * How far off the line an athlete may be and still be on the segment.
 *
 * Wide enough for ordinary GPS error, a parallel path on the other side of a
 * hedge, and a phone in a pack. Narrow enough that the road beside the trail
 * is a different route. Strava works to about the same figure.
 */
export const CORRIDOR_METRES = 25

/**
 * The fewest points a segment may be drawn with.
 *
 * Two points is a straight line between two places, which no trail is, and
 * matching it would accept anything that passed both ends.
 */
export const MIN_SEGMENT_POINTS = 3

export interface TrackPoint {
  lat: number
  lng: number
  /** Epoch milliseconds. A point without one cannot time anything. */
  time: number | null
}

export interface LatLngPoint {
  lat: number
  lng: number
}

export interface SegmentEffort {
  /** Index into the track where the effort started and finished. */
  startIndex: number
  endIndex: number
  /** Epoch milliseconds at the start of the effort. */
  startedAt: number
  elapsedSeconds: number
}

export function distanceMetres(a: LatLngPoint, b: LatLngPoint): number {
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const lat1 = a.lat * Math.PI / 180
  const lat2 = b.lat * Math.PI / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(h))
}

/** A box around a segment, widened by the corridor, for rejecting tracks cheaply. */
function bounds(points: LatLngPoint[], padMetres: number) {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
  for (const point of points) {
    if (point.lat < minLat) minLat = point.lat
    if (point.lat > maxLat) maxLat = point.lat
    if (point.lng < minLng) minLng = point.lng
    if (point.lng > maxLng) maxLng = point.lng
  }
  const padLat = padMetres / 111_320
  // Longitude degrees shrink with latitude; use the widest row of the box so
  // the pad is never too narrow.
  const cos = Math.cos((Math.abs(minLat) > Math.abs(maxLat) ? minLat : maxLat) * Math.PI / 180)
  const padLng = padMetres / (111_320 * Math.max(cos, 0.01))
  return { minLat: minLat - padLat, maxLat: maxLat + padLat, minLng: minLng - padLng, maxLng: maxLng + padLng }
}

/**
 * Every complete run of `segment` inside `track`, in the order they happened.
 *
 * More than one because laps exist: somebody doing hill repeats runs the same
 * segment six times in one activity, and each is its own effort.
 */
export function matchSegment(
  track: TrackPoint[],
  segment: LatLngPoint[],
  corridorMetres: number = CORRIDOR_METRES,
): SegmentEffort[] {
  if (segment.length < MIN_SEGMENT_POINTS || track.length < 2)
    return []

  // Cheap rejection first: most segments are nowhere near most activities, and
  // this is the difference between a save that feels instant and one that does
  // not once there are thousands of segments.
  const box = bounds(segment, corridorMetres)
  let anyInside = false
  for (const point of track) {
    if (point.lat >= box.minLat && point.lat <= box.maxLat && point.lng >= box.minLng && point.lng <= box.maxLng) {
      anyInside = true
      break
    }
  }
  if (!anyInside)
    return []

  const start = segment[0]
  const finish = segment[segment.length - 1]
  const efforts: SegmentEffort[] = []

  let from = 0
  while (from < track.length) {
    const startIndex = nearestWithin(track, start, corridorMetres, from)
    if (startIndex === -1)
      break

    const effort = effortFrom(track, segment, startIndex, finish, corridorMetres)
    if (effort) {
      efforts.push(effort)
      // Continue after this effort, so hill repeats each count once and an
      // effort cannot overlap the one before it.
      from = effort.endIndex + 1
    }
    else {
      // Passed the start without completing the segment — look for the next
      // approach rather than giving up on the whole activity.
      from = startIndex + 1
    }
  }

  return efforts
}

/**
 * One effort beginning at `startIndex`, or null if the track never completes
 * the segment from there.
 */
function effortFrom(
  track: TrackPoint[],
  segment: LatLngPoint[],
  startIndex: number,
  finish: LatLngPoint,
  corridor: number,
): SegmentEffort | null {
  // Walk the segment, requiring the track to keep up in the same direction.
  // `cursor` never goes backwards, which is what refuses the same ground run
  // the other way.
  let cursor = startIndex
  for (let s = 1; s < segment.length; s++) {
    const next = nearestWithin(track, segment[s], corridor, cursor)
    if (next === -1)
      return null
    cursor = next
  }

  // `cursor` is now at the segment's final point. Confirm it really is the
  // finish and not a stray fix that happened to be in range.
  if (distanceMetres(track[cursor], finish) > corridor)
    return null

  const startedAt = track[startIndex].time
  const endedAt = track[cursor].time
  if (startedAt === null || endedAt === null)
    return null

  const elapsedSeconds = Math.round((endedAt - startedAt) / 1000)
  // Zero or negative means the clock did not advance across the effort, which
  // is a broken track rather than an infinitely fast athlete.
  if (elapsedSeconds <= 0)
    return null

  return { startIndex, endIndex: cursor, startedAt, elapsedSeconds }
}

/**
 * The first index at or after `from` whose point is within `radius` of
 * `target`, or -1.
 *
 * First rather than nearest, deliberately: an effort is timed from when the
 * athlete reached the start, not from whichever nearby fix happened to be
 * closest to the drawn line.
 */
function nearestWithin(track: TrackPoint[], target: LatLngPoint, radius: number, from: number): number {
  for (let i = Math.max(0, from); i < track.length; i++) {
    if (distanceMetres(track[i], target) <= radius)
      return i
  }
  return -1
}

/**
 * Turning part of a recorded activity into a segment.
 *
 * A segment is drawn from a run somebody already did: they pick the climb out
 * of last Sunday's long one and name it. That is the only creation path worth
 * having first — it needs no map drawing, and a segment cut from a real track
 * is automatically a line somebody can actually follow, which a hand-drawn one
 * is not.
 *
 * Everything the `segments` table stores is derived here from the slice, so a
 * caller cannot save a row whose distance, ascent or bounding box disagrees
 * with its own geometry.
 */

import { emptyAnchor, step, totalMiles } from './recording-distance'
import { totalGainFt } from './recording-elevation'
import { MIN_SEGMENT_POINTS } from './segment-matching'

/** A recorded fix, as the activity stores it. */
export interface DraftSample {
  lat: number
  lng: number
  /** Feet above sea level, when the device reported any. */
  eleFt?: number | null
}

export interface SegmentDraft {
  name: string
  /** Simplified line, [lat, lng] pairs, as stored. */
  geometry: Array<[number, number]>
  /** Miles, by the same anchored rule an activity's distance uses. */
  distance: number
  /** Feet of ascent over the slice, smoothed the same way an activity's is. */
  elevation: number
  startLat: number
  startLng: number
  endLat: number
  endLng: number
  minLat: number
  maxLat: number
  minLng: number
  maxLng: number
}

export type DraftRefusal =
  | 'too-few-points'
  | 'too-short'
  | 'backwards'
  | 'no-name'

/**
 * The shortest a segment may be, in miles.
 *
 * Below about a tenth of a mile the matcher's own corridor is a meaningful
 * fraction of the segment, so whether somebody "ran it" stops being a question
 * about the ground and becomes one about GPS error. It is also the point below
 * which a leaderboard is timing noise rather than effort.
 */
export const MIN_SEGMENT_MILES = 0.1

/**
 * How many points a stored segment keeps.
 *
 * The matcher checks every segment point against the track, so a segment cut
 * from ten thousand fixes would cost ten thousand comparisons per candidate
 * activity for no more accuracy — the corridor is 25 metres wide and these
 * points are a stride apart.
 */
export const MAX_SEGMENT_POINTS = 300

export type DraftResult =
  | { ok: true, draft: SegmentDraft }
  | { ok: false, reason: DraftRefusal }

/**
 * Cut a segment out of an activity's track.
 *
 * `startIndex` and `endIndex` are into `samples`, inclusive, as the athlete
 * picked them.
 */
export function segmentDraft(
  samples: DraftSample[],
  startIndex: number,
  endIndex: number,
  name: string,
): DraftResult {
  const trimmed = name.trim()
  if (!trimmed)
    return { ok: false, reason: 'no-name' }

  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex) || endIndex <= startIndex)
    return { ok: false, reason: 'backwards' }

  const slice = samples
    .slice(Math.max(0, startIndex), Math.min(samples.length, endIndex + 1))
    .filter(sample => Number.isFinite(sample.lat) && Number.isFinite(sample.lng))

  if (slice.length < MIN_SEGMENT_POINTS)
    return { ok: false, reason: 'too-few-points' }

  const distance = totalMiles(slice.map(s => ({ lat: s.lat, lng: s.lng, accuracy: null })))
  if (distance < MIN_SEGMENT_MILES)
    return { ok: false, reason: 'too-short' }

  const geometry = simplify(slice)

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity
  for (const [lat, lng] of geometry) {
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lng < minLng) minLng = lng
    if (lng > maxLng) maxLng = lng
  }

  return {
    ok: true,
    draft: {
      name: trimmed,
      geometry,
      distance: Math.round(distance * 100) / 100,
      elevation: Math.round(totalGainFt(slice.map(s => ({ eleFt: s.eleFt ?? null })))),
      // Taken from the stored line rather than the slice, so the endpoints the
      // matcher looks for are points that are actually in the geometry.
      startLat: geometry[0][0],
      startLng: geometry[0][1],
      endLat: geometry[geometry.length - 1][0],
      endLng: geometry[geometry.length - 1][1],
      minLat,
      maxLat,
      minLng,
      maxLng,
    },
  }
}

/**
 * Thin the line to at most `MAX_SEGMENT_POINTS`, keeping both ends.
 *
 * Evenly by index rather than by shape: the matcher asks whether the track
 * came near each point, so points spread along the line serve it better than a
 * corner-preserving simplification that clusters them at the bends and leaves
 * a long straight stretch unchecked.
 */
function simplify(slice: DraftSample[]): Array<[number, number]> {
  if (slice.length <= MAX_SEGMENT_POINTS)
    return slice.map(sample => [round(sample.lat), round(sample.lng)])

  const stride = (slice.length - 1) / (MAX_SEGMENT_POINTS - 1)
  const points: Array<[number, number]> = []
  for (let i = 0; i < MAX_SEGMENT_POINTS; i++) {
    const sample = slice[Math.round(i * stride)]
    points.push([round(sample.lat), round(sample.lng)])
  }
  // Rounding can leave the last stride landing short; the finish must be the
  // finish, because it is what the matcher times the effort to.
  const last = slice[slice.length - 1]
  points[points.length - 1] = [round(last.lat), round(last.lng)]
  return points
}

/** Six decimals is about a tenth of a metre — past what any phone knows. */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/**
 * How far into the activity each sample is, in miles.
 *
 * The creation UI needs this to say "from 2.4 mi to 3.9 mi" while somebody
 * drags the ends around, and it has to be the same measure the segment will
 * end up with or the preview disagrees with the result.
 */
export function cumulativeMiles(samples: DraftSample[]): number[] {
  const out: number[] = []
  let anchor = emptyAnchor()
  for (const sample of samples) {
    if (Number.isFinite(sample.lat) && Number.isFinite(sample.lng))
      anchor = step(anchor, [sample.lat, sample.lng], null)
    out.push(Math.round(anchor.miles * 1000) / 1000)
  }
  return out
}

/**
 * The shape of a run, as a line of altitude against distance.
 *
 * Every trail app has this and Wildloop did not, so an activity page jumped
 * from a row of numbers straight to a map — which is most of why it read
 * thinner than AllTrails or Strava despite carrying comparable information.
 * "3,200 ft of climb" is a fact; where the climbing was is the story.
 *
 * Built on the server and sent as a short list of points rather than by
 * shipping the samples and drawing from them: a ten-hour recording is about
 * 36,000 fixes and 3.6MB of JSON, and nobody needs 36,000 points to see the
 * shape of a run on a phone.
 *
 * Altitude is smoothed with the same filter the recorder uses, for the same
 * reason — raw GPS altitude wanders ten to fifteen metres while standing
 * still, and an unsmoothed profile is a band of noise with a hill somewhere
 * inside it. Terrain is continuous, so smoothing costs nothing real.
 */

import { emptyAnchor, step } from './recording-distance'
import { ALTITUDE_SMOOTHING } from './recording-elevation'

/** One point on the drawn line. */
export interface ProfilePoint {
  /** Miles from the start. */
  mi: number
  /** Feet above sea level. */
  ft: number
}

export interface ElevationProfile {
  points: ProfilePoint[]
  /** Lowest and highest point, for labelling the axis without rescanning. */
  minFt: number
  maxFt: number
  /** Total distance the profile covers, in miles. */
  miles: number
}

/**
 * How many points a drawn profile gets.
 *
 * More than a phone has pixels across is wasted bytes; fewer and a sharp
 * summit starts to flatten. Two hundred is a point every couple of pixels on
 * a desktop chart and every half-mile on a hundred-mile route.
 */
export const PROFILE_POINTS = 200

const METRES_TO_FEET = 3.28084

interface AltitudeSample {
  lat: number
  lng: number
  altitude: number | null
}

/**
 * Turn a parsed track into a profile, or null when there is nothing to draw.
 *
 * Null rather than an empty profile, so a caller can leave the section out
 * entirely: a chart of one flat line says less than no chart at all, and every
 * activity logged by hand would otherwise get one.
 */
export function elevationProfile(samples: AltitudeSample[], maxPoints = PROFILE_POINTS): ElevationProfile | null {
  // Altitude in metres from the device; the rest of the app speaks feet.
  const usable: Array<{ lat: number, lng: number, ft: number }> = []
  for (const sample of samples) {
    if (!Number.isFinite(sample.lat) || !Number.isFinite(sample.lng))
      continue
    if (sample.altitude == null || !Number.isFinite(sample.altitude))
      continue
    usable.push({ lat: sample.lat, lng: sample.lng, ft: sample.altitude * METRES_TO_FEET })
  }

  // Two points is a line; one is a dot, and no altitude at all is a manual
  // entry or a device that never reported any.
  if (usable.length < 2)
    return null

  // Smoothed forwards, then the same filter backwards, so the line is not
  // dragged to the right the way a one-pass filter drags it. The shape has to
  // sit over the distance it actually happened at.
  const forward: number[] = []
  let running = usable[0].ft
  for (const point of usable) {
    running = ALTITUDE_SMOOTHING * point.ft + (1 - ALTITUDE_SMOOTHING) * running
    forward.push(running)
  }
  const smoothed = Array.from({ length: forward.length })
  running = forward[forward.length - 1]
  for (let i = forward.length - 1; i >= 0; i--) {
    running = ALTITUDE_SMOOTHING * forward[i] + (1 - ALTITUDE_SMOOTHING) * running
    smoothed[i] = running
  }

  /*
   * Cumulative distance, so the x axis is ground covered rather than fixes
   * taken: a profile plotted against sample number stretches the bit where
   * somebody stopped and squashes the descent they ran.
   *
   * Measured by the same anchored rule the activity's own distance uses, not
   * by summing every fix. Summing is 9% longer over a long day, which would
   * put "54.2 mi" under a profile whose page header says 50 — and of the two
   * numbers, the one in the header is the one the app means.
   */
  const cumulative: number[] = []
  let anchor = emptyAnchor()
  for (const point of usable) {
    anchor = step(anchor, [point.lat, point.lng], null)
    cumulative.push(anchor.miles)
  }

  const miles = cumulative[cumulative.length - 1]
  const stride = Math.max(1, Math.ceil(usable.length / maxPoints))

  const points: ProfilePoint[] = []
  for (let i = 0; i < usable.length; i += stride)
    points.push({ mi: round(cumulative[i], 3), ft: Math.round(smoothed[i] as number) })

  // The last fix always lands, whatever the stride: a profile that stops short
  // of the summit is wrong about the thing people look at it for.
  const lastIndex = usable.length - 1
  if (points[points.length - 1].mi !== round(cumulative[lastIndex], 3))
    points.push({ mi: round(cumulative[lastIndex], 3), ft: Math.round(smoothed[lastIndex] as number) })

  let minFt = points[0].ft
  let maxFt = points[0].ft
  for (const point of points) {
    if (point.ft < minFt) minFt = point.ft
    if (point.ft > maxFt) maxFt = point.ft
  }

  return { points, minFt, maxFt, miles: round(miles, 2) }
}

function round(value: number, places: number): number {
  const factor = 10 ** places
  return Math.round(value * factor) / factor
}

import type { RoutePair } from '../../resources/functions/trail-geometry'
import { primaryRoutePart } from '../../resources/functions/trail-geometry'

/**
 * Elevation gain for a stored trail, from the line it already carries.
 *
 * The catalog is ingested from OpenStreetMap, the Forest Service and the Park
 * Service, none of which give ascent for more than a handful of trails — a
 * sample of 400 production rows found gain on none of them, so nearly every
 * trail page says "Not recorded" where the number people check second, after
 * distance, belongs (#1002).
 *
 * The geometry is already stored, and `climbAlong()` already turns a line into
 * gain and loss for drawn routes, so the missing piece is only the decision of
 * which line to measure and what to do with an answer. That decision is here,
 * away from the command, so it can be tested without a routing server.
 */

/**
 * The fewest points worth asking about.
 *
 * Two points describe a straight line between them, and Valhalla will happily
 * return the two heights — but the gain between two samples of a mile-long
 * trail is not its ascent, it is the difference between its ends. Below this,
 * report nothing rather than a number that reads as measured.
 */
export const MIN_ELEVATION_POINTS = 8

/**
 * A gain above this is treated as a bad answer rather than a mountain.
 *
 * Everest is ~29,000 ft above sea level and the longest trails here are
 * thru-hikes that genuinely climb six figures of cumulative gain — but a
 * single line this app stores is one walkable part, and a five-digit gain on
 * one part means the sampler crossed a data void and read the sea floor, which
 * has happened to elevation services before. Park it rather than publish it.
 */
export const MAX_PLAUSIBLE_GAIN_FT = 60_000

export type ElevationOutcome =
  | { status: 'ok', gainFt: number }
  /** Nothing worth asking a routing server about. */
  | { status: 'unmeasurable', reason: 'no-geometry' | 'too-few-points' }
  /** Asked, and the answer cannot be true. */
  | { status: 'rejected', reason: 'implausible', gainFt: number }

/**
 * The line to measure: the trail's only part, or the longest of several.
 *
 * A trail assembled from relation members is stored as separate walkable
 * parts, because the straight line between two of them is somebody's back
 * garden rather than trail. Measuring the parts glued together would count
 * every one of those jumps as ascent. Measuring the main line is both correct
 * and consistent with the rest of the app, which already navigates, times
 * records against and downloads exactly this line.
 */
export function elevationLine(geometry: unknown): RoutePair[] {
  return primaryRoutePart(geometry)
}

/** Whether this row is worth a request at all, and why not when it is not. */
export function elevationRequest(geometry: unknown): { line: RoutePair[] } | Extract<ElevationOutcome, { status: 'unmeasurable' }> {
  const line = elevationLine(geometry)
  if (line.length === 0)
    return { status: 'unmeasurable', reason: 'no-geometry' }
  if (line.length < MIN_ELEVATION_POINTS)
    return { status: 'unmeasurable', reason: 'too-few-points' }
  return { line }
}

/**
 * What to store for a gain a routing server answered with.
 *
 * Rounded to whole feet, because the page prints whole feet. A gain of zero is
 * not written: the column treats 0 as "not recorded", so writing it would
 * claim a measurement the page then denies, and would make the row look done
 * to the next run of the backfill.
 */
export function elevationOutcome(gainFt: number | null | undefined): ElevationOutcome {
  if (typeof gainFt !== 'number' || !Number.isFinite(gainFt) || gainFt <= 0)
    return { status: 'unmeasurable', reason: 'too-few-points' }
  const rounded = Math.round(gainFt)
  if (rounded > MAX_PLAUSIBLE_GAIN_FT)
    return { status: 'rejected', reason: 'implausible', gainFt: rounded }
  return { status: 'ok', gainFt: rounded }
}

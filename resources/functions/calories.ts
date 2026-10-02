/**
 * A calorie estimate that knows what kind of activity it is looking at.
 *
 * What this replaces: four different formulas, one per place an activity could
 * be created. The feed served `distance * 95`, the recorder `minutes * 10`,
 * the manual form the same, and the importer a flat zero — so the same run
 * carried a different number depending on how it had been saved, and the
 * detail page showed whichever one the feed happened to leave in the store
 * (#1011).
 *
 * This is still an estimate and is labelled as one everywhere it is shown. The
 * reason it is worth computing properly anyway is that it sits beside ascent
 * and distance, which are now genuinely measured from the recorded track, in
 * the same type at the same weight. A reader cannot tell the measured numbers
 * from the guessed one by looking, so the guess should at least be a good one.
 *
 * Deliberately NOT using body weight. It is the largest term in any real
 * calorie model, and the app does not ask for it — inventing an athlete to
 * stand in for the real one buys accuracy that is not there. Everything here
 * is derived from what the activity already carries: its type, how long it
 * moved for, how far it went, and how much it climbed.
 */

import { activityKind } from './activity-physics'
import { parseDurationToSeconds } from './duration'

/** The reference adult this estimate is built around, in kilograms. */
export const REFERENCE_WEIGHT_KG = 70

/**
 * MET values at a reference pace, from the Compendium of Physical Activities.
 *
 * One MET is roughly a kilocalorie per kilogram per hour at rest. These are
 * the flat, steady-state figures; speed and ascent adjust them below.
 */
const BASE_MET: Record<string, number> = {
  run: 9.8, // ~6 mph / 10:00 per mile
  bike: 8.0, // ~14 mph
  hike: 6.0, // cross-country, light pack
  walk: 3.5, // ~3 mph
  other: 5.0,
}

/** The pace each base MET is quoted at, in miles per hour. */
const REFERENCE_MPH: Record<string, number> = {
  run: 6.0,
  bike: 14.0,
  hike: 2.5,
  walk: 3.0,
  other: 3.0,
}

/**
 * How much the MET moves with speed, as an exponent on the speed ratio.
 *
 * Running is 1.0, and that has a consequence worth stating outright: at an
 * exponent of exactly one the duration cancels, and a run's estimate becomes a
 * constant times its distance. Two six-mile runs an hour apart in pace get the
 * same number.
 *
 * That is not the bug this file was written to fix — it is the physiology.
 * Running costs roughly a fixed amount of energy per mile; the Compendium's
 * own figures bear it out (9.8 MET at 6 mph, 11.8 at 8 mph — near enough
 * proportional, in fact very slightly cheaper per mile when faster). So for a
 * flat run this lands near the `distance * 95` it replaces, by about 114, and
 * that agreement is a point in favour of both.
 *
 * The estimate earns its keep everywhere else: on the climb term, and on the
 * other three activity types, where the old multiplier was simply wrong.
 * Cycling scales harder than linearly because drag dominates; walking barely
 * scales at all until it turns into a run.
 */
const SPEED_EXPONENT: Record<string, number> = {
  run: 1.0,
  bike: 1.8,
  hike: 0.8,
  walk: 0.6,
  other: 0.8,
}

/**
 * The energy cost of climbing, in kilocalories per kilogram per metre gained.
 *
 * Raising a mass takes a fixed amount of work; muscle converts chemical energy
 * to that work at roughly 22% efficiency, which is where this figure comes
 * from. It is added on top of the horizontal cost rather than folded into the
 * MET, because ascent is the term that most clearly separates a hike up a
 * mountain from the same distance along a river — and ascent is measured.
 */
const CLIMB_KCAL_PER_KG_PER_METRE = 0.0125

const FEET_PER_METRE = 3.28084

/** Caps a ratio so a bad duration or distance cannot produce an absurd figure. */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

export interface CalorieInput {
  /** Free-text activity type, e.g. "Trail Run". Mapped via `activityKind`. */
  activityType: string
  /** Distance in miles. */
  distanceMiles: number | null | undefined
  /** Moving time, either in seconds or as a "H:MM:SS" / "MM:SS" string. */
  movingTime: number | string | null | undefined
  /** Elevation gained, in feet. */
  elevationGainFeet?: number | null
}

/** Moving time in seconds, from either shape the app stores it in. */
function secondsFrom(movingTime: number | string | null | undefined): number | null {
  if (movingTime === null || movingTime === undefined)
    return null
  if (typeof movingTime === 'number')
    return Number.isFinite(movingTime) && movingTime > 0 ? movingTime : null
  const parsed = parseDurationToSeconds(movingTime)
  return parsed !== null && parsed > 0 ? parsed : null
}

/**
 * An estimated calorie burn, or null when there is not enough to estimate from.
 *
 * Null rather than zero on purpose. Zero is a measurement — it says the
 * activity burned nothing — and the importer used to write exactly that for
 * every file it read. Null says the app does not know, which is the truth, and
 * lets the tile hide itself rather than print a confident nought.
 */
export function estimateCalories(input: CalorieInput): number | null {
  const seconds = secondsFrom(input.movingTime)
  if (seconds === null)
    return null

  const kind = activityKind(input.activityType ?? '')
  const hours = seconds / 3600

  const baseMet = BASE_MET[kind] ?? BASE_MET.other
  const referenceMph = REFERENCE_MPH[kind] ?? REFERENCE_MPH.other
  const exponent = SPEED_EXPONENT[kind] ?? SPEED_EXPONENT.other

  const miles = Number(input.distanceMiles ?? 0)
  const mph = Number.isFinite(miles) && miles > 0 && hours > 0 ? miles / hours : 0

  /*
   * Without a usable distance this falls back to the activity's base MET,
   * which is what the type alone can honestly say. A GPS-less manual entry of
   * "two hours of hiking" is still worth an estimate.
   */
  const speedRatio = mph > 0 ? clamp(mph / referenceMph, 0.3, 3) : 1
  const met = baseMet * speedRatio ** exponent

  const horizontal = met * REFERENCE_WEIGHT_KG * hours

  const gainFeet = Number(input.elevationGainFeet ?? 0)
  const gainMetres = Number.isFinite(gainFeet) && gainFeet > 0 ? gainFeet / FEET_PER_METRE : 0
  const climb = gainMetres * REFERENCE_WEIGHT_KG * CLIMB_KCAL_PER_KG_PER_METRE

  const total = Math.round(horizontal + climb)
  return total > 0 ? total : null
}

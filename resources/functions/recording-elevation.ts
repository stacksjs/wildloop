/**
 * How much an activity actually climbed.
 *
 * GPS altitude is the worst number a phone reports. Horizontal error is
 * metres; vertical error is one and a half to three times that, so a receiver
 * claiming five metres horizontally is wandering ten to fifteen vertically
 * while sitting on a table. Counting every positive change above a three-foot
 * floor therefore counts the wander: simulated at one fix a second, standing
 * still for an hour accrued between 1,400 and 29,000 feet of climb, and a
 * ten-hour ultra with 8,000 feet of real ascent reported 58,000 to 298,000.
 *
 * That is not merely wrong on the page. The store action accepts elevation
 * only between 0 and 100,000 feet and rejects the whole activity outside it,
 * so a long enough day could finish with the run refused at save.
 *
 * Two things fix it, and the second is the one that matters. A floor alone
 * cannot work — the noise is correlated, so it wanders past any threshold
 * worth setting, and even sixty feet still trebled the total. The signal has
 * to be smoothed first.
 *
 * Smoothing is safe here in a way it is not for distance. A route doubles back
 * on itself — a switchback reverses direction in seconds, and smoothing the
 * horizontal track cuts the corner and loses real miles. Terrain does not do
 * that: ground rises and falls continuously, and nobody climbs a hundred feet
 * in two seconds. So a low-pass filter removes noise here and takes almost no
 * signal with it.
 *
 * What remains is deliberately biased high. Both parameters were chosen from
 * simulation against rolling terrain, preferring a small over-count to any
 * risk of quietly erasing a climb somebody made.
 */

/**
 * How much of each new reading to believe.
 *
 * A time constant of about twenty-five samples — under half a minute at one
 * fix a second. Chosen against rolling terrain rather than against a clean
 * climb: heavier smoothing measures a steady ascent beautifully and quietly
 * erases the rollers either side of it. At 0.02 a five-minute fifty-foot
 * roller lost 23% of its climb, which is the same mistake as smoothing a
 * switchback. At 0.04 it lands within one percent.
 */
export const ALTITUDE_SMOOTHING = 0.04

/**
 * How far the smoothed altitude must move before it is believed, in feet.
 *
 * Hysteresis: climbing banks the rise once it clears the floor, descending
 * only moves the reference down. Fifteen feet is about two storeys, below any
 * hill worth counting and above what survives the smoothing.
 */
export const ALTITUDE_FLOOR_FT = 15

export interface ElevationAnchor {
  /** The smoothed altitude, in feet. */
  smoothed: number | null
  /** The altitude the last banked gain was measured from. */
  anchor: number | null
  /** Feet of ascent accepted so far. */
  gainFt: number
}

export function emptyElevation(): ElevationAnchor {
  return { smoothed: null, anchor: null, gainFt: 0 }
}

/**
 * Fold one altitude reading into the running total.
 *
 * `null` — which is what a browser reports when it has no altitude at all —
 * passes through untouched rather than counting as a descent to sea level.
 */
export function stepElevation(state: ElevationAnchor, altitudeFt: number | null | undefined): ElevationAnchor {
  if (altitudeFt == null || !Number.isFinite(altitudeFt))
    return state

  const smoothed = state.smoothed === null
    ? altitudeFt
    : ALTITUDE_SMOOTHING * altitudeFt + (1 - ALTITUDE_SMOOTHING) * state.smoothed

  if (state.anchor === null)
    return { smoothed, anchor: smoothed, gainFt: state.gainFt }

  // Climbed far enough to be a hill rather than the receiver breathing.
  if (smoothed >= state.anchor + ALTITUDE_FLOOR_FT)
    return { smoothed, anchor: smoothed, gainFt: state.gainFt + (smoothed - state.anchor) }

  // Dropped far enough to be a descent: the next climb is measured from here,
  // which is what stops a long downhill banking gain on the way back up.
  if (smoothed <= state.anchor - ALTITUDE_FLOOR_FT)
    return { smoothed, anchor: smoothed, gainFt: state.gainFt }

  return { ...state, smoothed }
}

/** Total ascent over a stored track, by the same rule the live run used. */
export function totalGainFt(samples: Array<{ eleFt?: number | null }>): number {
  let state = emptyElevation()
  for (const sample of samples)
    state = stepElevation(state, sample.eleFt ?? null)
  return state.gainFt
}

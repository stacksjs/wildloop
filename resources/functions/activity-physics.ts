/**
 * What a human body can actually do.
 *
 * The existing integrity pass caps instantaneous speed, which stops a track
 * that teleports but lets through a great deal that is plainly not running. A
 * cap of 12 m/s permits 2:30/km held for an hour — nobody has ever done that,
 * and a car in city traffic does it easily. It also permits a standing start to
 * full sprint between two consecutive samples, and a track that gains a
 * kilometre of altitude in a minute.
 *
 * The limits here are deliberately far above elite performance rather than near
 * it. The purpose is to catch vehicles and fabrication, not to adjudicate
 * whether somebody is a good runner — a legitimate athlete being told their run
 * does not count is a worse failure than a cheat getting through, because the
 * athlete is real, is angry, and is right.
 */

export type ActivityKind = 'run' | 'bike' | 'walk' | 'hike' | 'other'

/** Map Wildloop's free-text activity type onto the curves below. */
export function activityKind(activityType: string): ActivityKind {
  const value = activityType.trim().toLowerCase()
  // `bik` rather than `bike`: athletes write "Mountain Biking" as often as "Bike".
  if (value.includes('bik') || value.includes('cycl') || value.includes('ride'))
    return 'bike'
  if (value.includes('walk'))
    return 'walk'
  if (value.includes('hike'))
    return 'hike'
  if (value.includes('run') || value.includes('jog'))
    return 'run'
  return 'other'
}

/**
 * World-record average speeds, in metres per second, at a few distances.
 *
 * Interpolated between and extended beyond, then multiplied by a generous
 * margin. These are the anchors, not the limits.
 */
const RUN_RECORDS: Array<[seconds: number, speed: number]> = [
  [10, 12.4], // 100 m
  [45, 10.4], // 400 m
  [210, 8.2], // 1500 m
  [780, 7.6], // 5000 m
  [1580, 7.1], // 10 000 m
  [3540, 6.7], // half marathon
  [7300, 5.9], // marathon
  [21600, 5.0], // 6 hours
  [86400, 4.0], // 24 hours
]

const BIKE_RECORDS: Array<[seconds: number, speed: number]> = [
  [10, 22.0], // track sprint
  [60, 19.0],
  [3600, 16.5], // hour record
  [14400, 14.0],
  [86400, 11.5], // 24-hour record
]

const WALK_RECORDS: Array<[seconds: number, speed: number]> = [
  [60, 4.6], // race walking
  [1200, 4.2],
  [7200, 3.9],
  [86400, 3.0],
]

/**
 * Headroom over the record curve.
 *
 * Wide enough to cover the ways a legitimate measurement beats a track record:
 * GPS overestimates distance on a winding path, a net descent beats any flat
 * time, and a phone is not a timing gate. Narrow enough to still mean
 * something — at 1.5 the limit for a five-minute effort lands above 12 m/s,
 * which is a car in traffic, and a limit that admits cars is not a limit.
 */
const MARGIN = 1.25

function interpolate(curve: Array<[number, number]>, seconds: number): number {
  if (seconds <= curve[0][0])
    return curve[0][1]

  for (let i = 1; i < curve.length; i++) {
    const [t1, v1] = curve[i]
    if (seconds <= t1) {
      const [t0, v0] = curve[i - 1]
      // Logarithmic in time: the record curve is close to straight on a log
      // axis, and linear interpolation between hour and day would be far too
      // generous in between.
      const ratio = (Math.log(seconds) - Math.log(t0)) / (Math.log(t1) - Math.log(t0))
      return v0 + (v1 - v0) * ratio
    }
  }

  // Past the longest anchor, hold the slowest record rather than extrapolating
  // to zero — a multi-day effort is rare but real.
  return curve[curve.length - 1][1]
}

/**
 * The fastest average speed a human could plausibly hold for this long.
 *
 * Used against the whole activity and against long stretches of it, which is
 * what an instantaneous cap cannot see: a car doing a steady 11 m/s passes
 * every per-sample check ever written for running.
 */
export function maxSustainableSpeed(kind: ActivityKind, seconds: number): number {
  const duration = Math.max(1, seconds)
  const curve = kind === 'bike'
    ? BIKE_RECORDS
    : kind === 'walk'
      ? WALK_RECORDS
      // A hike is a walk that may involve scrambling; anything unrecognised is
      // given the running curve, which is the more permissive of the two.
      : kind === 'hike' ? WALK_RECORDS : RUN_RECORDS

  const margin = kind === 'hike' ? MARGIN * 1.3 : MARGIN
  return interpolate(curve, duration) * margin
}

/**
 * The fastest instantaneous speed worth allowing between two samples.
 *
 * Separate from the sustained curve: a sprint downhill for four seconds is
 * legitimate and would breach any average-based limit.
 */
export function maxBurstSpeed(kind: ActivityKind): number {
  switch (kind) {
    case 'bike':
      return 30 // ~108 km/h, a fast descent
    case 'walk':
      return 8
    case 'hike':
      return 10
    default:
      return 14 // faster than any sprinter has run
  }
}

/**
 * The fastest change of speed worth allowing, in metres per second squared.
 *
 * A human accelerates at about 4 m/s² flat out. GPS noise adds apparent
 * acceleration that is not real, especially at low speeds and under cover, so
 * this is several times that — it is here to catch a track assembled from
 * waypoints, where speed jumps between legs with nothing in between.
 */
export const MAX_ACCELERATION = 12

/** Metres of altitude per second. Faster than any climb and any descent on foot. */
export const MAX_VERTICAL_SPEED = 6

export interface SpeedSegment {
  /** Metres covered. */
  distance: number
  /** Seconds taken. */
  seconds: number
  /** Metres per second. */
  speed: number
  /** Altitude change in metres, where both samples reported one. */
  climb: number | null
}

/**
 * The worst sustained pace over any window of at least `minSeconds`.
 *
 * A whole-activity average hides a car ride bracketed by a warm-up and a
 * cool-down: twenty minutes at 20 m/s inside a two-hour activity barely moves
 * the average. Checking every window catches the stretch itself.
 *
 * Runs over a prefix-sum, so the whole scan is linear in the number of samples
 * regardless of how many windows it considers.
 */
export function worstSustainedWindow(
  segments: SpeedSegment[],
  minSeconds: number,
): { speed: number, seconds: number, distance: number } | null {
  if (segments.length === 0)
    return null

  const cumulativeTime: number[] = [0]
  const cumulativeDistance: number[] = [0]
  for (const segment of segments) {
    cumulativeTime.push(cumulativeTime[cumulativeTime.length - 1] + segment.seconds)
    cumulativeDistance.push(cumulativeDistance[cumulativeDistance.length - 1] + segment.distance)
  }

  let worst: { speed: number, seconds: number, distance: number } | null = null
  let start = 0

  for (let end = 1; end < cumulativeTime.length; end++) {
    // Shrink from the left while the window is still long enough: the fastest
    // window ending here is the shortest one that still qualifies.
    while (start + 1 < end && cumulativeTime[end] - cumulativeTime[start + 1] >= minSeconds)
      start++

    const seconds = cumulativeTime[end] - cumulativeTime[start]
    if (seconds < minSeconds)
      continue

    const distance = cumulativeDistance[end] - cumulativeDistance[start]
    const speed = distance / seconds
    if (!worst || speed > worst.speed)
      worst = { speed, seconds, distance }
  }

  return worst
}

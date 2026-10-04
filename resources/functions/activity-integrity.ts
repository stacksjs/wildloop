import type { Coordinate } from './geo'
import type { AnomalySignal } from './activity-anomaly'
import type { SpeedSegment } from './activity-physics'
import { detectAnomalies, trackFingerprint } from './activity-anomaly'
import { totalMiles } from './recording-distance'
import {
  activityKind,
  MAX_ACCELERATION,
  MAX_VERTICAL_SPEED,
  maxBurstSpeed,
  maxSustainableSpeed,
  worstSustainedWindow,
} from './activity-physics'

export type RecordingSource = 'web_gps' | 'native_gps' | 'simulation' | 'manual' | 'file_import' | 'garmin'

export function isLiveGpsSource(source: RecordingSource): boolean {
  return source === 'web_gps' || source === 'native_gps'
}

export interface TrackSample extends Coordinate {
  /** Wall-clock epoch milliseconds. */
  time: number | null
  /** Horizontal accuracy radius reported by the device, in metres. */
  accuracy: number | null
  altitude: number | null
}

export interface TrackIntegrityResult {
  valid: boolean
  captureEligible: boolean
  status: 'verified' | 'unverified' | 'rejected'
  reason: string | null
  samples: TrackSample[]
  distanceMiles: number | null
  durationSeconds: number | null
  /**
   * How much this track resembles a construction rather than a recording,
   * from 0 to 1. Never on its own a reason to refuse a capture — it is a
   * queue order for human review.
   */
  anomalyScore: number
  /** What drove that score, in the terms a reviewer thinks in. */
  anomalySignals: AnomalySignal[]
  /**
   * Shape hash, for spotting the same trace submitted twice. Null when the
   * track is too short to fingerprint.
   */
  fingerprint: string | null
  /**
   * Positions in the submitted telemetry that were dropped as GPS glitches or
   * duplicates, ascending. `samples` and every number above are already
   * without them; `withoutFixes` takes them out of the stored track too.
   */
  droppedFixes: number[]
}


function finite(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value
  return typeof number === 'number' && Number.isFinite(number) ? number : null
}

function haversineMetres(a: Coordinate, b: Coordinate): number {
  const radius = 6371000
  const dLat = (b.lat - a.lat) * Math.PI / 180
  const dLng = (b.lng - a.lng) * Math.PI / 180
  const x = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) ** 2
  return 2 * radius * Math.asin(Math.sqrt(x))
}

/** Parse Wildloop's GeoJSON telemetry envelope while retaining provenance. */
export function parseTrackSamples(raw: string | null | undefined): TrackSample[] {
  if (!raw)
    return []

  try {
    const value = JSON.parse(raw)
    if (value?.type === 'LineString' && Array.isArray(value.coordinates)) {
      const telemetry = Array.isArray(value?.properties?.samples) ? value.properties.samples : []
      return value.coordinates.map((coordinate: unknown, index: number) => {
        const pair = Array.isArray(coordinate) ? coordinate : []
        const sample = telemetry[index] ?? {}
        return {
          lng: finite(pair[0]) ?? Number.NaN,
          lat: finite(pair[1]) ?? Number.NaN,
          time: finite(sample.time ?? sample.t),
          accuracy: finite(sample.accuracy),
          altitude: finite(sample.altitude),
        }
      })
    }

    if (Array.isArray(value)) {
      return value.map((sample: any) => ({
        lat: finite(sample?.lat) ?? Number.NaN,
        lng: finite(sample?.lng ?? sample?.lon) ?? Number.NaN,
        time: finite(sample?.time ?? sample?.t),
        accuracy: finite(sample?.accuracy),
        altitude: finite(sample?.altitude),
      }))
    }
  }
  catch {
    return []
  }

  return []
}

function rejected(reason: string, samples: TrackSample[] = []): TrackIntegrityResult {
  return {
    valid: false,
    captureEligible: false,
    status: 'rejected',
    reason,
    samples,
    distanceMiles: null,
    durationSeconds: null,
    anomalyScore: 0,
    anomalySignals: [],
    fingerprint: null,
    droppedFixes: [],
  }
}

/*
 * How wrong a fix can be.
 *
 * A receiver reports an accuracy radius with every fix, and it is roughly one
 * standard deviation: the real position is outside it about a third of the
 * time. The physics checks used to compare raw consecutive positions as if
 * they were exact, so two honest fixes ten metres wrong in opposite
 * directions, a second apart, read as a 20 m/s sprint — and one such pair
 * refused the whole run, which the athlete then lost from their log as well.
 *
 * So a step is only impossible when it is impossible even after each end is
 * allowed two of its own radii of error. A receiver that does not say gets a
 * clear-sky floor.
 */

/** Metres: a fix's error radius when the device does not report one. */
const ACCURACY_FLOOR_M = 5
/** How many reported radii a fix is allowed to be out by. */
const ACCURACY_SIGMAS = 2
/** GPS altitude is worse than position, typically by half again. */
const VERTICAL_ERROR_FACTOR = 1.5

/**
 * The most fixes in a row that can be a glitch.
 *
 * Multipath off a cliff or a building, or a receiver still settling, throws a
 * fix or a few out and then recovers. A jump that persists longer than this is
 * not a glitch — it is the athlete being somewhere else, and is judged as such.
 */
const MAX_GLITCH_RUN = 3

/**
 * The share of fixes that can be dropped and the run still score. Past this
 * the signal was poor enough that the line is a guess: the run is kept in the
 * log, but it does not draw territory.
 */
const MAX_GLITCH_SHARE = 0.1

/**
 * Seconds over which speed is also judged, end to end.
 *
 * A fix's error is mostly shared with the fix a second later — receivers
 * drift, they do not jump — so allowing each end of a one-second step its full
 * error is generous, and at one fix a second it lets 30 m/s through as noise.
 * Over ten seconds the same allowance is a tenth as large against the
 * distance, which refuses a car while still forgiving a receiver that wanders.
 */
const SPAN_SECONDS = 10

function errorRadius(sample: TrackSample): number {
  return sample.accuracy !== null && sample.accuracy >= 0
    ? Math.max(sample.accuracy, ACCURACY_FLOOR_M)
    : ACCURACY_FLOOR_M
}

/** Metres either fix may be out by, together. */
function stepError(a: TrackSample, b: TrackSample): number {
  return ACCURACY_SIGMAS * (errorRadius(a) + errorRadius(b))
}

interface StepBounds {
  seconds: number
  metres: number
  /** The slowest speed the two fixes allow, given their error. */
  minSpeed: number
  /** The fastest. */
  maxSpeed: number
  /** The least climb rate they allow, m/s, or null without altitude. */
  minVerticalSpeed: number | null
}

function stepBounds(a: TrackSample, b: TrackSample): StepBounds | null {
  if (a.time === null || b.time === null)
    return null
  const seconds = (b.time - a.time) / 1000
  if (seconds <= 0)
    return null
  const metres = haversineMetres(a, b)
  const error = stepError(a, b)
  const climb = a.altitude !== null && b.altitude !== null ? Math.abs(b.altitude - a.altitude) : null
  return {
    seconds,
    metres,
    minSpeed: Math.max(0, metres - error) / seconds,
    maxSpeed: (metres + error) / seconds,
    minVerticalSpeed: climb === null ? null : Math.max(0, climb - VERTICAL_ERROR_FACTOR * error) / seconds,
  }
}

/** Whether a body could have made this step, given what the fixes say of their own error. */
function possibleStep(bounds: StepBounds, burstLimit: number): boolean {
  return bounds.minSpeed <= burstLimit
    && (bounds.minVerticalSpeed === null || bounds.minVerticalSpeed <= MAX_VERTICAL_SPEED)
}

/**
 * The fixes worth judging, with glitches taken out.
 *
 * Walks the track keeping a last good fix. A fix that could not have been
 * reached from it is a glitch only if, within `MAX_GLITCH_RUN` fixes, the
 * track comes back to somewhere that could: then the excursion is dropped. If
 * it never comes back, the move is real and the step is what gets judged.
 * The very first fixes get the same treatment in reverse, because a receiver
 * that has not settled can start the track somewhere it was not.
 *
 * Returns the indices kept.
 */
function withoutGlitches(samples: TrackSample[], burstLimit: number): number[] {
  const possible = (from: TrackSample, to: TrackSample): boolean => {
    const bounds = stepBounds(from, to)
    return bounds !== null && possibleStep(bounds, burstLimit)
  }

  let firstUsable = 0
  for (let start = 0; start <= MAX_GLITCH_RUN && start < samples.length; start++) {
    // A start fix is only to be distrusted when the one after cannot be
    // reached from it but the track agrees with itself from there on.
    if (start + 2 < samples.length
      && !possible(samples[start], samples[start + 1])
      && possible(samples[start + 1], samples[start + 2])) {
      firstUsable = start + 1
      continue
    }
    break
  }

  const kept = [firstUsable]
  let index = firstUsable + 1
  while (index < samples.length) {
    const anchor = samples[kept[kept.length - 1]]
    if (possible(anchor, samples[index])) {
      kept.push(index)
      index++
      continue
    }

    let rejoin = index + 1
    while (rejoin < samples.length && rejoin <= index + MAX_GLITCH_RUN && !possible(anchor, samples[rejoin]))
      rejoin++

    if (rejoin < samples.length && rejoin <= index + MAX_GLITCH_RUN) {
      // An excursion that came back: drop it.
      index = rejoin
    }
    else if (samples.length - index <= MAX_GLITCH_RUN) {
      // The last few fixes, gone wrong as the phone was put away.
      break
    }
    else {
      // It did not come back. Keep it, and let the checks judge the step.
      kept.push(index)
      index++
    }
  }

  return kept
}

/**
 * The submitted telemetry with some fixes taken out, in the shape it came in.
 *
 * Used to store a track without its glitches, so the territory engine — which
 * reads the stored track — never claims ground along a fix the integrity
 * check already decided was not where the athlete was. Every per-fix array in
 * the envelope is filtered alike, so samples stay aligned with coordinates.
 */
export function withoutFixes(raw: string, drop: number[]): string {
  if (drop.length === 0)
    return raw
  const dropped = new Set(drop)
  const keep = (_: unknown, index: number): boolean => !dropped.has(index)

  try {
    const value = JSON.parse(raw)
    if (Array.isArray(value))
      return JSON.stringify(value.filter(keep))

    if (value?.type === 'LineString' && Array.isArray(value.coordinates)) {
      const length = value.coordinates.length
      const properties = value.properties && typeof value.properties === 'object' ? { ...value.properties } : value.properties
      if (properties && typeof properties === 'object') {
        for (const [key, entry] of Object.entries(properties)) {
          if (Array.isArray(entry) && entry.length === length)
            properties[key] = entry.filter(keep)
        }
      }
      return JSON.stringify({ ...value, coordinates: value.coordinates.filter(keep), ...(properties !== undefined ? { properties } : {}) })
    }
  }
  catch {}
  return raw
}

/**
 * Derive trusted activity metrics and territory eligibility from raw samples.
 * This is deliberately stricter than ordinary activity saving: an imperfect
 * track may remain in the athlete's private log while being refused for play.
 */
export function evaluateTrackIntegrity(input: {
  gpxData?: string | null
  source: RecordingSource
  activityType: string
  completedAt?: string | null
  nowMs?: number
}): TrackIntegrityResult {
  const { source } = input
  if (!input.gpxData) {
    return {
      valid: true,
      captureEligible: false,
      status: 'unverified',
      reason: source === 'manual' ? 'Manual activities cannot capture territory' : 'No GPS telemetry supplied',
      samples: [],
      distanceMiles: null,
      durationSeconds: null,
      anomalyScore: 0,
      anomalySignals: [],
      fingerprint: null,
      droppedFixes: [],
    }
  }

  const submitted = parseTrackSamples(input.gpxData)
  if (submitted.length < 2)
    return rejected('Track must include at least two valid telemetry samples', submitted)

  for (const sample of submitted) {
    if (!Number.isFinite(sample.lat) || !Number.isFinite(sample.lng)
      || sample.lat < -90 || sample.lat > 90 || sample.lng < -180 || sample.lng > 180)
      return rejected('Track contains an invalid coordinate', submitted)
  }

  const kind = activityKind(input.activityType)
  const burstLimit = maxBurstSpeed(kind)

  /*
   * Order, duplicates and glitches, for live GPS only.
   *
   * Time going backwards is refused: no receiver does that. Two fixes with the
   * same time and the same place within their error are one fix delivered
   * twice, which phones do, and are merged. The same time in two different
   * places is still refused — a step that takes no time cannot be judged, so
   * it cannot be let through.
   */
  let liveKept: number[] | null = null
  let duplicates = 0
  if (isLiveGpsSource(source) && submitted.every(sample => sample.time !== null)) {
    const unique: number[] = [0]
    for (let index = 1; index < submitted.length; index++) {
      const previous = submitted[unique[unique.length - 1]]
      const sample = submitted[index]
      if ((sample.time as number) < (previous.time as number))
        return rejected('Track timestamps must increase monotonically', submitted)
      if (sample.time === previous.time) {
        if (haversineMetres(previous, sample) > stepError(previous, sample))
          return rejected('Track timestamps must increase monotonically', submitted)
        duplicates++
        continue
      }
      unique.push(index)
    }

    const uniqueSamples = unique.map(index => submitted[index])
    liveKept = withoutGlitches(uniqueSamples, burstLimit).map(position => unique[position])
  }

  const kept = new Set(liveKept ?? submitted.map((_, index) => index))
  const samples = submitted.filter((_, index) => kept.has(index))
  const droppedFixes = submitted.map((_, index) => index).filter(index => !kept.has(index))
  // A fix delivered twice costs nothing; only fixes that were wrong count.
  const glitchShare = (droppedFixes.length - duplicates) / submitted.length

  let distanceMetres = 0
  let previousTime: number | null = null
  let timedSamples = 0
  let accurateSamples = 0

  // Kept for the checks that need the shape of the whole effort rather than
  // one step of it: sustained pace, acceleration, and the anomaly pass.
  const segments: SpeedSegment[] = []
  const speeds: number[] = []
  const intervals: number[] = []
  let previousBounds: StepBounds | null = null
  let spanStart = 0

  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]
    if (sample.accuracy !== null && sample.accuracy >= 0 && sample.accuracy <= 75)
      accurateSamples++
    if (sample.time !== null) {
      timedSamples++
      if (previousTime !== null && sample.time <= previousTime)
        return rejected('Track timestamps must increase monotonically', samples)
      previousTime = sample.time
    }
    if (index === 0)
      continue

    const previous = samples[index - 1]
    const segmentMetres = haversineMetres(previous, sample)
    distanceMetres += segmentMetres
    const startTime = previous.time

    if (isLiveGpsSource(source) && startTime !== null && sample.time !== null) {
      const bounds = stepBounds(previous, sample)
      if (!bounds)
        return rejected('Track timestamps must increase monotonically', samples)
      const { seconds } = bounds

      const speed = segmentMetres / seconds
      if (bounds.minSpeed > burstLimit)
        return rejected(`Track contains an implausible ${input.activityType.toLowerCase()} speed`, samples)

      // A track assembled from waypoints jumps between speeds with nothing in
      // between. A body cannot: it has to accelerate, and the limit here is
      // several times what a sprinter manages, so only construction trips it.
      // Judged on the least change the two steps' error allows: from one
      // second to the next, GPS noise alone moves the measured speed by more
      // than a sprinter's acceleration.
      if (previousBounds !== null) {
        const leastChange = Math.max(0, bounds.minSpeed - previousBounds.maxSpeed, previousBounds.minSpeed - bounds.maxSpeed)
        if (leastChange / seconds > MAX_ACCELERATION)
          return rejected('Track contains an implausible change of speed', samples)
      }

      // Altitude climbs faster than this in a lift, not on a trail.
      if (bounds.minVerticalSpeed !== null && bounds.minVerticalSpeed > MAX_VERTICAL_SPEED)
        return rejected('Track contains an implausible change of altitude', samples)

      // The same two limits over the last ten seconds or so, end to end. The
      // straight line between the ends is the least distance covered, so this
      // only ever undercounts.
      while (spanStart + 1 < index && (sample.time - (samples[spanStart + 1].time as number)) / 1000 >= SPAN_SECONDS)
        spanStart++
      const spanFrom = samples[spanStart]
      if (spanStart < index - 1 && spanFrom.time !== null && (sample.time - spanFrom.time) / 1000 >= SPAN_SECONDS) {
        const span = stepBounds(spanFrom, sample)
        if (span && span.minSpeed > burstLimit)
          return rejected(`Track contains an implausible ${input.activityType.toLowerCase()} speed`, samples)
        if (span?.minVerticalSpeed != null && span.minVerticalSpeed > MAX_VERTICAL_SPEED)
          return rejected('Track contains an implausible change of altitude', samples)
      }

      previousBounds = bounds
      speeds.push(speed)
      intervals.push(seconds)
      segments.push({
        distance: segmentMetres,
        seconds,
        speed,
        climb: previous.altitude !== null && sample.altitude !== null
          ? sample.altitude - previous.altitude
          : null,
      })
    }
    else if (isLiveGpsSource(source) && segmentMetres > 2000) {
      return rejected('Track contains an implausible GPS jump', samples)
    }
  }

  // A per-sample cap says nothing about a pace held for an hour. Twelve metres
  // per second is 2:30/km — legitimate for four seconds downhill, and a car in
  // traffic for twenty minutes. Every window of at least five minutes is
  // checked against what a body can hold for that long.
  if (isLiveGpsSource(source) && segments.length > 0) {
    const window = worstSustainedWindow(segments, 300)
    if (window && window.speed > maxSustainableSpeed(kind, window.seconds)) {
      return rejected(
        `Track holds ${window.speed.toFixed(1)} m/s for ${Math.round(window.seconds / 60)} minutes, which is faster than a ${kind === 'other' ? 'human' : kind} sustains`,
        samples,
      )
    }
  }

  const firstTime = samples[0].time
  const lastTime = samples[samples.length - 1].time
  const durationSeconds = firstTime !== null && lastTime !== null
    ? Math.round((lastTime - firstTime) / 1000)
    : null
  /*
   * The distance the activity is saved with, measured from anchors rather than
   * from every consecutive fix.
   *
   * `distanceMetres` above is the raw sum, and it stays raw because the checks
   * around it are about the shape of each step — a burst speed between two
   * fixes means something whether or not those two fixes were far enough apart
   * to count as travel.
   *
   * What gets stored is a different question. A GPS fix is a guess with a
   * radius that does not shrink when you stand still, so the raw sum charges
   * the athlete for the receiver's own wander: at one fix a second that is one
   * to nine phantom miles for every hour spent standing. A fifty-mile ultra
   * with three quarters of an hour of aid stations came back three to seven
   * miles long, and this is the number that decides it — the store action
   * overrides whatever the phone reported with this one for live GPS.
   */
  const distanceMiles = totalMiles(samples)

  const fingerprint = trackFingerprint(samples)

  if (!isLiveGpsSource(source)) {
    return {
      valid: true,
      captureEligible: false,
      status: 'unverified',
      reason: `${source.replace('_', ' ')} activities are activity-log only`,
      samples,
      distanceMiles,
      durationSeconds,
      anomalyScore: 0,
      anomalySignals: [],
      fingerprint,
      droppedFixes,
    }
  }

  // Run for live tracks only, and only to be reported: these signals say a
  // track looks constructed, which is a reason for a person to look at it and
  // never on its own a reason to refuse it.
  const anomalies = detectAnomalies({ samples, speeds, intervals })

  const nowMs = input.nowMs ?? Date.now()
  const completedMs = input.completedAt ? Date.parse(input.completedAt) : nowMs
  const hasEnoughTelemetry = samples.length >= 20
    && timedSamples === samples.length
    && accurateSamples / samples.length >= 0.8
    && durationSeconds !== null
    && durationSeconds >= 120
    && distanceMetres >= 100
    && Number.isFinite(completedMs)
    && Math.abs(nowMs - completedMs) <= 24 * 60 * 60 * 1000
  const steadyEnough = glitchShare <= MAX_GLITCH_SHARE
  const eligible = hasEnoughTelemetry && steadyEnough

  return {
    valid: true,
    captureEligible: eligible,
    status: eligible ? 'verified' : 'unverified',
    reason: eligible
      ? null
      : !hasEnoughTelemetry
          ? 'Capture requires 20+ recent timestamped GPS samples with device accuracy'
          : 'GPS signal was too unsteady to draw territory from this run',
    samples,
    distanceMiles,
    durationSeconds,
    anomalyScore: anomalies.score,
    anomalySignals: anomalies.signals,
    fingerprint,
    droppedFixes,
  }
}

export function durationLabel(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`
}

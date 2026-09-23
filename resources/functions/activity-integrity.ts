import type { Coordinate } from './geo'
import type { AnomalySignal } from './activity-anomaly'
import type { SpeedSegment } from './activity-physics'
import { detectAnomalies, trackFingerprint } from './activity-anomaly'
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
}

const METRES_PER_MILE = 1609.344

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
  }
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
    }
  }

  const samples = parseTrackSamples(input.gpxData)
  if (samples.length < 2)
    return rejected('Track must include at least two valid telemetry samples', samples)

  for (const sample of samples) {
    if (!Number.isFinite(sample.lat) || !Number.isFinite(sample.lng)
      || sample.lat < -90 || sample.lat > 90 || sample.lng < -180 || sample.lng > 180)
      return rejected('Track contains an invalid coordinate', samples)
  }

  let distanceMetres = 0
  let previousTime: number | null = null
  let timedSamples = 0
  let accurateSamples = 0
  const kind = activityKind(input.activityType)
  const burstLimit = maxBurstSpeed(kind)

  // Kept for the checks that need the shape of the whole effort rather than
  // one step of it: sustained pace, acceleration, and the anomaly pass.
  const segments: SpeedSegment[] = []
  const speeds: number[] = []
  const intervals: number[] = []
  let previousSpeed: number | null = null

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
      const seconds = (sample.time - startTime) / 1000
      if (seconds <= 0)
        return rejected('Track timestamps must increase monotonically', samples)

      const speed = segmentMetres / seconds
      if (speed > burstLimit)
        return rejected(`Track contains an implausible ${input.activityType.toLowerCase()} speed`, samples)

      // A track assembled from waypoints jumps between speeds with nothing in
      // between. A body cannot: it has to accelerate, and the limit here is
      // several times what a sprinter manages, so only construction trips it.
      if (previousSpeed !== null) {
        const acceleration = Math.abs(speed - previousSpeed) / seconds
        if (acceleration > MAX_ACCELERATION)
          return rejected('Track contains an implausible change of speed', samples)
      }

      // Altitude climbs faster than this in a lift, not on a trail.
      if (previous.altitude !== null && sample.altitude !== null) {
        const climb = sample.altitude - previous.altitude
        if (Math.abs(climb) / seconds > MAX_VERTICAL_SPEED)
          return rejected('Track contains an implausible change of altitude', samples)
      }

      previousSpeed = speed
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
  const distanceMiles = distanceMetres / METRES_PER_MILE

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

  return {
    valid: true,
    captureEligible: hasEnoughTelemetry,
    status: hasEnoughTelemetry ? 'verified' : 'unverified',
    reason: hasEnoughTelemetry ? null : 'Capture requires 20+ recent timestamped GPS samples with device accuracy',
    samples,
    distanceMiles,
    durationSeconds,
    anomalyScore: anomalies.score,
    anomalySignals: anomalies.signals,
    fingerprint,
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

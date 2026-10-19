import type { RecorderSample } from './splits'
import type { NativeLocationSample } from './recording-samples'
import { mergeNativeLocationSamples } from './recording-samples'
import { totalMiles } from './recording-distance'
import { totalGainFt } from './recording-elevation'
import { routeToGeoJson } from './track-export'
import { computeSplitsFromSamples } from './splits'

export interface NativeRecording {
  userId: number
  id: string | null
  startedAt: number
  type: string
  visibility: string
  gameMode: 'capture' | 'free'
  targetTerritoryId: number | null
  pauses: Array<{ start: number, end: number | null }>
  samples: RecorderSample[]
  phase?: 'starting' | 'recording' | 'stopped'
  endedAt?: number
  pending?: Record<string, unknown>
}

export function nativeRecordingDuration(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  return whole >= 3600 ? `${Math.floor(whole / 3600)}:${String(Math.floor(whole / 60) % 60).padStart(2,'0')}:${String(whole % 60).padStart(2,'0')}` : `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2,'0')}`
}
export function movingSeconds(recording: NativeRecording, now: number): number {
  const pausedMs = recording.pauses.reduce((sum, pause) => sum + Math.max(0, Math.min(now, pause.end ?? now) - pause.start),0)
  return Math.max(0, (now - recording.startedAt - pausedMs) / 1000)
}
/** Preserve native fixes, deduplicate foreground replay, and retain pause-aware split timing. */
export function recordingSamples(recording: NativeRecording, locations: NativeLocationSample[]): RecorderSample[] {
  return mergeNativeLocationSamples(recording.samples,locations)
    .filter(sample => !recording.pauses.some(pause => sample.t > pause.start && sample.t < (pause.end ?? Infinity)))
    .map(sample => ({...sample,movingS:movingSeconds(recording,sample.t)}))
}
/** Distance and ascent restart their anchors after each deliberate pause. */
export function recordingFigures(recording: NativeRecording): {distance:number,elevation:number} {
  const segments: RecorderSample[][] = [[]]
  let previous = recording.samples[0]?.t ?? 0
  for (const sample of recording.samples) {
    if (recording.pauses.some(pause => pause.start >= previous && pause.start < sample.t)) segments.push([])
    segments.at(-1)!.push(sample)
    previous = sample.t
  }
  return {distance:segments.reduce((sum,segment) => sum + totalMiles(segment),0),elevation:segments.reduce((sum,segment) => sum + totalGainFt(segment),0)}
}
/** The exact same altitude envelope, distance rules and split calculation as the web recorder. */
export function recordingPayload(recording: NativeRecording, endedAt: number): Record<string,unknown> {
  const figures = recordingFigures(recording)
  const moving = movingSeconds(recording,endedAt)
  return {
    activity_type:recording.type,distance:Number(figures.distance.toFixed(2)),elevation:Math.round(figures.elevation),
    duration:nativeRecordingDuration((endedAt-recording.startedAt)/1000),moving_time:nativeRecordingDuration(moving),
    pace:figures.distance > 0.01 ? `${nativeRecordingDuration(moving/figures.distance)}/mi` : null,
    gpx_data:routeToGeoJson(recording.samples.map(sample => [sample.lat,sample.lng]),recording.samples),
    splits:computeSplitsFromSamples(recording.samples),visibility:recording.visibility,completed_at:new Date(endedAt).toISOString(),
    upload_id:`run:${recording.id}`,recording_source:'native_gps',game_mode:recording.gameMode,target_territory_id:recording.targetTerritoryId,
  }
}

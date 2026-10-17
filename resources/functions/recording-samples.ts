import type { RecorderSample } from './splits'

export interface NativeLocationSample {
  latitude: number
  longitude: number
  altitude?: number
  accuracy: number
  timestamp: number
}


function sampleKey(sample: Pick<RecorderSample, 'lat' | 'lng' | 't'>): string {
  return `${Math.round(sample.t)}:${sample.lat.toFixed(6)}:${sample.lng.toFixed(6)}`
}

function isValidNativeLocationSample(sample: NativeLocationSample): boolean {
  return Number.isFinite(sample.latitude)
    && Number.isFinite(sample.longitude)
    && Number.isFinite(sample.timestamp)
    && sample.timestamp > 0
    && sample.latitude >= -90
    && sample.latitude <= 90
    && sample.longitude >= -180
    && sample.longitude <= 180
}

/** Merge native background samples without double-counting foreground fixes. */
export function mergeNativeLocationSamples(current: RecorderSample[], native: NativeLocationSample[]): RecorderSample[] {
  const merged = [...current]
  const seen = new Set(merged.map(sampleKey))
  for (const location of native) {
    // A malformed bridge payload must never turn distance, elevation, or pace
    // into NaN. Ignore the bad point and retain the trustworthy route around it.
    if (!isValidNativeLocationSample(location)) continue
    const sample: RecorderSample = {
      lat: location.latitude,
      lng: location.longitude,
      t: location.timestamp,
      eleFt: Number.isFinite(location.altitude) ? location.altitude! * 3.28084 : null,
      movingS: 0,
      accuracy: Number.isFinite(location.accuracy) ? location.accuracy : null,
    }
    const key = sampleKey(sample)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(sample)
  }
  merged.sort((left, right) => left.t - right.t)
  return merged
}

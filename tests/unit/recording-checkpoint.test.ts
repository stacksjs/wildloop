import { describe, expect, it } from 'bun:test'
import { isRecordingCheckpointStale, mergeNativeLocationSamples, ownsRecordingCheckpoint, RECORDING_CHECKPOINT_MAX_AGE_MS } from '../../resources/assets/scripts/recording-checkpoint'

describe('durable recording samples', () => {
  it('merges background locations in timestamp order without duplicates', () => {
    const merged = mergeNativeLocationSamples([
      { lat: 37, lng: -122, t: 2_000, eleFt: 10, movingS: 2, accuracy: 4 },
    ], [
      { latitude: 36.9, longitude: -122.1, timestamp: 1_000, altitude: 2, accuracy: 5 },
      { latitude: 37, longitude: -122, timestamp: 2_000, altitude: 3, accuracy: 4 },
    ])

    expect(merged).toHaveLength(2)
    expect(merged.map(sample => sample.t)).toEqual([1_000, 2_000])
    expect(merged[0].eleFt).toBeCloseTo(6.56168)
  })

  it('ignores malformed native samples so a bridge payload cannot poison route metrics', () => {
    const merged = mergeNativeLocationSamples([], [
      { latitude: Number.NaN, longitude: -122, timestamp: 1_000, accuracy: 4 },
      { latitude: 37, longitude: -122, timestamp: 0, accuracy: 4 },
      { latitude: 37, longitude: -122, timestamp: 2_000, altitude: Number.NaN, accuracy: Number.NaN },
      { latitude: 91, longitude: -122, timestamp: 3_000, accuracy: 4 },
    ])

    expect(merged).toEqual([
      { lat: 37, lng: -122, t: 2_000, eleFt: null, movingS: 0, accuracy: null },
    ])
  })

  it('retains a checkpoint at its recovery boundary and expires only older drafts', () => {
    const now = 2_000_000_000

    expect(isRecordingCheckpointStale({ savedAt: now - RECORDING_CHECKPOINT_MAX_AGE_MS }, now)).toBe(false)
    expect(isRecordingCheckpointStale({ savedAt: now - RECORDING_CHECKPOINT_MAX_AGE_MS - 1 }, now)).toBe(true)
  })

  it('retains a checkpoint when a corrected device clock is earlier than the save', () => {
    expect(isRecordingCheckpointStale({ savedAt: 2_000 }, 1_000)).toBe(false)
  })

  it('only recovers checkpoints owned by the active authenticated account', () => {
    expect(ownsRecordingCheckpoint({ userId: 42 }, 42)).toBe(true)
    expect(ownsRecordingCheckpoint({ userId: 42 }, 7)).toBe(false)
    expect(ownsRecordingCheckpoint({ userId: 42 }, 0)).toBe(false)
    expect(ownsRecordingCheckpoint(null, 42)).toBe(false)
  })
})

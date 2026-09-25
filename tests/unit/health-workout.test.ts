import { describe, expect, it } from 'bun:test'
import { createHealthWorkout } from '../../resources/functions/health-workout'

describe('native Health workout payload', () => {
  it('maps a completed trail run into Health units and a stable activity identity', () => {
    const workout = createHealthWorkout({
      activityId: 42,
      activityType: 'Trail Run',
      startedAt: 1_700_000_000_000,
      endedAt: 1_700_000_600_000,
      distanceMiles: 2.5,
      elapsedSeconds: 600,
      samples: [{ lat: 37.77, lng: -122.42, eleFt: 100, accuracy: 6, t: 1_700_000_000_000 }],
    })

    expect(workout).toMatchObject({
      activityId: 'wildloop:42',
      type: 'running',
      startDate: 1_700_000_000_000,
      endDate: 1_700_000_600_000,
      distanceMeters: 4023.36,
      activeEnergyCalories: 100,
    })
    expect(workout.locations).toEqual([{
      latitude: 37.77,
      longitude: -122.42,
      altitude: 30.48,
      accuracy: 6,
      timestamp: 1_700_000_000_000,
    }])
  })

  it('maps each supported Wildloop activity to its native workout type', () => {
    const types = ['Trail Run', 'Hike', 'Walk', 'Bike'] as const
    expect(types.map(activityType => createHealthWorkout({
      activityId: 1,
      activityType,
      startedAt: 1,
      endedAt: 2,
      distanceMiles: 0,
      elapsedSeconds: 0,
      samples: [],
    }).type)).toEqual(['running', 'hiking', 'walking', 'cycling'])
  })

  it('does not export malformed route samples to native Health', () => {
    const workout = createHealthWorkout({
      activityId: 7,
      activityType: 'Hike',
      startedAt: 1,
      endedAt: 2,
      distanceMiles: 1,
      elapsedSeconds: 60,
      samples: [
        { lat: Number.NaN, lng: -122.42, t: 1 },
        { lat: 37.77, lng: 181, t: 2 },
        { lat: 37.77, lng: -122.42, t: 0 },
        { lat: 37.77, lng: -122.42, t: 3 },
      ],
    })

    expect(workout.locations).toEqual([{
      latitude: 37.77,
      longitude: -122.42,
      altitude: undefined,
      accuracy: undefined,
      timestamp: 3,
    }])
  })
})

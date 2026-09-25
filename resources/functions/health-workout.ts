import type { HealthWorkout, HealthWorkoutType } from '@stacksjs/mobile'

export interface HealthWorkoutSample {
  lat: number
  lng: number
  eleFt?: number | null
  accuracy?: number | null
  t: number
}

export interface HealthWorkoutInput {
  activityId: number
  activityType: 'Trail Run' | 'Hike' | 'Walk' | 'Bike'
  startedAt: number
  endedAt: number
  distanceMiles: number
  elapsedSeconds: number
  samples: HealthWorkoutSample[]
}

const workoutTypes: Record<HealthWorkoutInput['activityType'], HealthWorkoutType> = {
  'Trail Run': 'running',
  Hike: 'hiking',
  Walk: 'walking',
  Bike: 'cycling',
}

const METERS_PER_MILE = 1609.344
const METERS_PER_FOOT = 0.3048

function isUsableHealthLocation(sample: HealthWorkoutSample): boolean {
  return Number.isFinite(sample.lat)
    && Number.isFinite(sample.lng)
    && sample.lat >= -90
    && sample.lat <= 90
    && sample.lng >= -180
    && sample.lng <= 180
    && Number.isFinite(sample.t)
    && sample.t > 0
}

/** Map a completed Wildloop recording into the portable native Health workout format. */
export function createHealthWorkout(input: HealthWorkoutInput): HealthWorkout {
  return {
    activityId: `wildloop:${input.activityId}`,
    type: workoutTypes[input.activityType],
    startDate: input.startedAt,
    endDate: input.endedAt,
    distanceMeters: input.distanceMiles * METERS_PER_MILE,
    // Keep this intentionally conservative until a device heart-rate or energy
    // source is available. It is the same estimate displayed in the activity UI.
    activeEnergyCalories: Math.max(1, Math.round(input.elapsedSeconds / 60 * 10)),
    // A native bridge or imported checkpoint must not turn one malformed
    // sample into a rejected Health workout. The recording integrity layer
    // remains authoritative for activities; this is a final export boundary.
    locations: input.samples.filter(isUsableHealthLocation).map(sample => ({
      latitude: sample.lat,
      longitude: sample.lng,
      altitude: sample.eleFt == null ? undefined : sample.eleFt * METERS_PER_FOOT,
      accuracy: sample.accuracy ?? undefined,
      timestamp: sample.t,
    })),
  }
}

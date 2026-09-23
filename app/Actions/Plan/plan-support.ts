import type { TripPlan, TripPlanFields, TripPlanInput } from '../../../resources/functions/trip-plans'
import { localDate, validateTripPlan } from '../../../resources/functions/trip-plans'
import Trail from '../../Models/Trail'

/** The fields a request may set on a plan; anything else is ignored. */
const INPUT_KEYS = [
  'trail_id', 'title', 'place_label', 'latitude', 'longitude', 'planned_for',
  'start_time', 'timezone', 'activity_type', 'notes',
] as const

export function readPlanInput(request: { get: (key: string) => unknown }): TripPlanInput {
  const input: TripPlanInput = {}
  for (const key of INPUT_KEYS) {
    const value = request.get(key)
    if (value !== undefined)
      input[key] = value
  }
  return input
}

/**
 * Validate against the day it is where the person is. Their timezone comes
 * with the request; a server in UTC would otherwise refuse a plan for
 * "today" made in California after 5 PM.
 */
export function validatePlanRequest(input: TripPlanInput, partial = false): ReturnType<typeof validateTripPlan> {
  const timezone = typeof input.timezone === 'string' ? input.timezone : null
  return validateTripPlan(input, { today: localDate(timezone), partial })
}

/**
 * A plan on a catalog trail takes the trail's own trailhead and name. The
 * page sends them too, but the catalog is the authority on where a trail
 * starts; a stale cached copy on the device is not.
 */
export async function applyTrail(value: Partial<TripPlanFields>, fields: Record<string, string>): Promise<void> {
  if (!value.trail_id)
    return
  const trail = await Trail.find(value.trail_id).catch(() => null) as any
  if (!trail) {
    fields.trail_id = 'That trail is no longer in the catalog'
    return
  }
  const lat = Number(trail.latitude)
  const lng = Number(trail.longitude)
  if (Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0)) {
    value.latitude = lat
    value.longitude = lng
    delete fields.location
  }
  if (!value.title && trail.name) {
    value.title = String(trail.name).slice(0, 120)
    delete fields.title
  }
  if (!value.place_label) {
    // `location` is usually already "Aspen, CO"; the state is only for a
    // trail that has none.
    const place = trail.location || trail.state_name || trail.state || ''
    value.place_label = String(place).slice(0, 200) || null
  }
}

export function planResponse(row: any): TripPlan {
  return {
    id: Number(row.id),
    uuid: row.uuid ?? null,
    trail_id: row.trail_id ? Number(row.trail_id) : null,
    title: row.title,
    place_label: row.place_label ?? null,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    planned_for: row.planned_for,
    start_time: row.start_time ?? null,
    timezone: row.timezone ?? null,
    activity_type: row.activity_type ?? null,
    notes: row.notes ?? null,
    reminded_at: row.reminded_at ?? null,
    created_at: row.created_at ?? null,
  }
}

export function validationFailed(fields: Record<string, string>) {
  return response.json({ success: false, error: 'Validation failed', fields }, 422)
}

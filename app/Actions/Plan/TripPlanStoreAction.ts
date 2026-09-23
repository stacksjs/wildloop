import { Auth } from '@stacksjs/auth'
import TripPlan from '../../Models/TripPlan'
import { applyTrail, planResponse, readPlanInput, validatePlanRequest, validationFailed } from './plan-support'

/** POST /api/plans — plan a trail or a spot for a day. */
export default new Action({
  name: 'Trip Plan Store',
  description: 'Plan a trail or a spot for a day',
  method: 'POST',
  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const { value, fields } = validatePlanRequest(readPlanInput(request))
    await applyTrail(value, fields)
    if (Object.keys(fields).length)
      return validationFailed(fields)

    const saved = await TripPlan.forceCreate({
      user_id: user.id,
      trail_id: value.trail_id ?? null,
      title: value.title,
      place_label: value.place_label ?? null,
      latitude: value.latitude,
      longitude: value.longitude,
      planned_for: value.planned_for,
      start_time: value.start_time ?? null,
      timezone: value.timezone ?? null,
      activity_type: value.activity_type ?? null,
      notes: value.notes ?? null,
      reminded_at: null,
    })
    // Read back rather than echo the create result, which does not carry
    // every column: the page keeps what this returns as the plan.
    const stored = await TripPlan.find((saved as any).id)
    return response.json({ success: true, plan: planResponse(stored ?? saved) }, 201)
  },
})

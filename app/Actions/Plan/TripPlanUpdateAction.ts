import { Auth } from '@stacksjs/auth'
import TripPlan from '../../Models/TripPlan'
import { applyTrail, planResponse, readPlanInput, validatePlanRequest, validationFailed } from './plan-support'

/**
 * PATCH /api/plans/{id} — change the date, time, notes or destination.
 *
 * Moving the date re-arms the day-before reminder: a plan pushed from
 * tomorrow to next Saturday should be reminded again before Saturday.
 */
export default new Action({
  name: 'Trip Plan Update',
  description: 'Edit one of the signed-in athlete trip plans',
  method: 'PATCH',
  async handle(request) {
    const user = await Auth.user().catch(() => null)
    const id = positiveInt(request.get('id'))
    if (!user)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!id)
      return response.json({ success: false, error: 'Plan ID is required' }, 422)

    const existing = await TripPlan.find(id) as any
    if (!existing || existing.user_id !== user.id)
      return response.json({ success: false, error: 'Plan not found' }, 404)

    const { value, fields } = validatePlanRequest(readPlanInput(request), true)
    await applyTrail(value, fields)
    if (Object.keys(fields).length)
      return validationFailed(fields)

    const changes: Record<string, unknown> = { ...value }
    if (value.planned_for && value.planned_for !== existing.planned_for)
      changes.reminded_at = null
    if (Object.keys(changes).length)
      await TripPlan.where('id', '=', id).update(changes)

    const updated = await TripPlan.find(id)
    return response.json({ success: true, plan: planResponse(updated) })
  },
})

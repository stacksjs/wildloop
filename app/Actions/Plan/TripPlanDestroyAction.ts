import { Auth } from '@stacksjs/auth'
import TripPlan from '../../Models/TripPlan'

/** DELETE /api/plans/{id} — cancel a plan. */
export default new Action({
  name: 'Trip Plan Destroy',
  description: 'Delete one of the signed-in athlete trip plans',
  method: 'DELETE',
  async handle(request) {
    const user = await Auth.user().catch(() => null)
    const id = positiveInt(request.get('id'))
    if (!user)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!id)
      return response.json({ success: false, error: 'Plan ID is required' }, 422)
    const plan = await TripPlan.find(id) as any
    if (!plan || plan.user_id !== user.id)
      return response.json({ success: false, error: 'Plan not found' }, 404)
    await TripPlan.delete(id)
    return response.json({ success: true })
  },
})

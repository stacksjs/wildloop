import { Auth } from '@stacksjs/auth'
import TripPlan from '../../Models/TripPlan'
import { planResponse } from '../../Support/tripPlanRequest'

/**
 * GET /api/plans — every plan the signed-in person has, upcoming and past.
 *
 * All of them in one answer, newest date first: a person's plans number in
 * the dozens, the page splits them by day, and the device keeps this list
 * for offline use. The cap only stops a runaway account.
 */
export default new Action({
  name: 'Trip Plan Index',
  description: 'List the signed-in athlete trip plans',
  method: 'GET',
  async handle() {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    const rows = (await TripPlan.where('user_id', '=', user.id).orderBy('planned_for', 'desc').limit(500).get()) ?? []
    return response.json({ success: true, plans: rows.map(planResponse) })
  },
})

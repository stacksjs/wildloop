import { Auth } from '@stacksjs/auth'

import { routeResponse } from './CustomRouteIndexAction'
import { readRouteInput } from '../../Support/customRouteRequest'
import CustomRoute from '../../Models/CustomRoute'

/**
 * PATCH /api/custom-routes/{id} — save an edited route over itself, so
 * reshaping a saved route in the planner does not leave a copy behind (and
 * plans made from it follow the new line).
 */
export default new Action({
  name: 'Custom Route Update',
  description: 'Replace the line, name and climb of one saved custom route owned by the athlete',
  method: 'PATCH',
  async handle(request) {
    const user = await Auth.user().catch(() => null)
    const id = positiveInt(request.get('id'))
    if (!user) return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!id) return response.json({ success: false, error: 'Route ID is required' }, 422)
    const existing = await CustomRoute.find(id)
    if (!existing || existing.user_id !== user.id) return response.json({ success: false, error: 'Route not found' }, 404)
    const input = readRouteInput(request)
    if ('error' in input)
      return response.json({ success: false, error: input.error }, 422)
    await CustomRoute.where('id', '=', id).update(input.columns)
    return response.json({ success: true, route: routeResponse(await CustomRoute.find(id)) })
  },
})

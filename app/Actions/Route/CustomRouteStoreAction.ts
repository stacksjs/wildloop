import { Auth } from '@stacksjs/auth'

import { routeResponse } from './CustomRouteIndexAction'
import { readRouteInput } from '../../Support/customRouteRequest'
import CustomRoute from '../../Models/CustomRoute'

export default new Action({
  name: 'Custom Route Store',
  description: 'Validate and save a custom outdoor route',
  method: 'POST',
  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user) return response.json({ success: false, error: 'Authentication required' }, 401)
    const input = readRouteInput(request)
    if ('error' in input)
      return response.json({ success: false, error: input.error }, 422)
    const saved = await CustomRoute.forceCreate({ user_id: user.id, ...input.columns })
    // Read back: the create result does not carry every column, and the
    // echo came back with no line and closedLoop false for every route.
    const stored = await CustomRoute.find((saved as any).id)
    return response.json({ success: true, route: routeResponse(stored ?? saved) }, 201)
  },
})

import { routeResponse } from '../../Support/customRouteResponse'
import { Auth } from '@stacksjs/auth'

import CustomRoute from '../../Models/CustomRoute'

export default new Action({
  name: 'Custom Route Index',
  description: 'List the authenticated athlete saved routes',
  method: 'GET',
  async handle() {
    const user = await Auth.user().catch(() => null)
    if (!user) return response.json({ success: false, error: 'Authentication required' }, 401)
    const routes = (await CustomRoute.where('user_id', '=', user.id).orderBy('created_at', 'desc').limit(100).get()) ?? []
    return response.json({ success: true, routes: routes.map(routeResponse) })
  },
})

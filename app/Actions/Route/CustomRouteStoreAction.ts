import { Auth } from '@stacksjs/auth'

import { routeResponse } from './CustomRouteIndexAction'
import CustomRoute from '../../Models/CustomRoute'

export default new Action({
  name: 'Custom Route Store',
  description: 'Validate and save a custom outdoor route',
  method: 'POST',
  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user) return response.json({ success: false, error: 'Authentication required' }, 401)
    const name = boundedString(request.get('name'), 200)
    const input = request.get('route')
    const route = Array.isArray(input) ? input : []
    const coordinates = route.slice(0, 10000).map((point: any) => ({ lat: Number(point?.[0]), lng: Number(point?.[1]) }))
    const valid = coordinates.length >= 2 && coordinates.every((point: any) => Number.isFinite(point.lat) && Number.isFinite(point.lng) && point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180)
    if (!name || !valid)
      return response.json({ success: false, error: 'A name and at least two valid route points are required' }, 422)
    let distance = 0
    for (let index = 1; index < coordinates.length; index++)
      distance += haversineDistance(coordinates[index - 1], coordinates[index])
    const closedLoop = haversineDistance(coordinates[0], coordinates[coordinates.length - 1]) <= 50
    const saved = await CustomRoute.forceCreate({
      user_id: user.id,
      name,
      route_data: JSON.stringify(coordinates.map(point => [point.lat, point.lng])),
      distance: distance / 1609.344,
      elevation: Math.max(0, Number(request.get('elevation')) || 0),
      closed_loop: closedLoop,
    })
    // Read back: the create result does not carry every column, and the
    // echo came back with no line and closedLoop false for every route.
    const stored = await CustomRoute.find((saved as any).id)
    return response.json({ success: true, route: routeResponse(stored ?? saved) }, 201)
  },
})

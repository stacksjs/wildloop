import { Action } from '@stacksjs/actions'
import { cache } from '@stacksjs/cache'
import { response } from '@stacksjs/router'
import { positiveInt } from '../../../resources/functions/validate'
import { withEdgeCache } from '../../Support/edgeCache'
import { trailProfile } from '../../Support/trailProfile'

/** Thirty days: long enough that a trail is measured once per deploy, not once an hour. */
const PROFILE_TTL_SECONDS = 30 * 24 * 3600

export default new Action({
  name: 'Trail Elevation Profile',
  description: 'Measured terrain elevation along the main trail route',
  method: 'GET',
  async handle(request) {
    const id = positiveInt(request.getParam('id'))
    if (!id)
      return response.json({ success: false, error: 'A positive trail ID is required' }, 422)
    const trail = await Trail.find(id)
    if (!trail)
      return response.json({ success: false, error: 'Trail not found' }, 404)
    try {
      // The key names the geometry it was measured on, so a cached profile
      // is never stale: an edited route is a new key. An hour's expiry only
      // sent each trail back to the elevation service (600-800ms) every hour.
      const key = `trail-profile:v1:${id}:${Bun.hash(String(trail.geometry)).toString(16)}`
      const points = await cache.getOrSet(key, () => trailProfile(trail.geometry), PROFILE_TTL_SECONDS)
      return withEdgeCache(request, response.json({ success: true, points }), 'detail')
    }
    catch {
      return response.json({ success: false, error: 'Elevation is unavailable right now' }, 503)
    }
  },
})

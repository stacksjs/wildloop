import { Action } from '@stacksjs/actions'
import { response } from '@stacksjs/router'
import { positiveInt } from '../../../resources/functions/validate'
import { durableCache } from '../../Support/durableCache'
import { withEdgeCache } from '../../Support/edgeCache'
import { trailProfile } from '../../Support/trailProfile'

/** Thirty days. The key names the geometry, so this only bounds the table's size. */
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
      // is never stale: an edited route is a new key. Kept across deploys
      // (Support/durableCache), where memory measured every trail again after
      // each one, at 600-800ms from the elevation service.
      const key = `trail-profile:v1:${id}:${Bun.hash(String(trail.geometry)).toString(16)}`
      const points = await durableCache().getOrSet(key, () => trailProfile(trail.geometry), PROFILE_TTL_SECONDS)
      return withEdgeCache(request, response.json({ success: true, points }), 'detail')
    }
    catch {
      return response.json({ success: false, error: 'Elevation is unavailable right now' }, 503)
    }
  },
})

import { decodePolyline } from '../../../resources/functions/polyline'
import { climbAlong } from '../../Support/routing'

/**
 * GET /api/geo/climb?path=<encoded polyline> — how much a drawn route goes
 * up and down, in feet. The path is an encoded polyline so a long route
 * still fits in a URL.
 */
export default new Action({
  name: 'Geo Climb',
  description: 'Elevation gain and loss along a drawn route',
  method: 'GET',
  async handle(request) {
    const raw = request.get('path')
    const points = typeof raw === 'string' && raw.length <= 20_000 ? decodePolyline(raw) : []
    if (points.length < 2)
      return response.json({ success: false, error: 'path must be an encoded polyline of at least two points' }, 422)
    try {
      const { gainFt, lossFt } = await climbAlong(points.map(([lat, lng]) => ({ lat, lng })))
      return response.json({ success: true, gainFt, lossFt })
    }
    catch {
      return response.json({ success: true, gainFt: null, lossFt: null, reason: 'Elevation is unavailable right now' })
    }
  },
})

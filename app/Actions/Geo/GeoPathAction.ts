import { footpathBetween, readPoint } from '../../Support/routing'

/** Farther apart than this in one tap is a slip of the finger, not a leg. */
const MAX_LEG_METERS = 40_000

/**
 * GET /api/geo/path?from=lat,lng&to=lat,lng — the walking line between two
 * taps on the route builder, along footpaths and trails.
 *
 * When there is no path (open water, private land, a routing outage) the
 * answer is `routed: false` and the builder draws that leg straight: the
 * person keeps drawing, and the leg is marked as not following a path.
 */
export default new Action({
  name: 'Geo Path',
  description: 'Route one leg of a drawn route along footpaths',
  method: 'GET',
  async handle(request) {
    const from = readPoint(request.get('from'))
    const to = readPoint(request.get('to'))
    if (!from || !to)
      return response.json({ success: false, error: 'from and to are required as lat,lng' }, 422)
    if (haversineDistance(from, to) > MAX_LEG_METERS)
      return response.json({ success: true, routed: false, reason: 'Too far for one leg — tap closer points', points: [[from.lat, from.lng], [to.lat, to.lng]] })

    try {
      const line = await footpathBetween(from, to)
      return response.json({ success: true, routed: true, points: line.map(p => [p.lat, p.lng]) })
    }
    catch (error) {
      return response.json({
        success: true,
        routed: false,
        reason: error instanceof Error && /No route|400/.test(error.message) ? 'No path between these points' : 'Path routing is unavailable right now',
        points: [[from.lat, from.lng], [to.lat, to.lng]],
      })
    }
  },
})

import { GEONAMES_ATTRIBUTION, parseGazetteerQuery } from 'ts-maps/gazetteer'
import { openGazetteer } from '../../Support/gazetteer'

/**
 * GET /api/geo/reverse?lat=..&lng=.. — the nearest town to a point, so a pin
 * dropped on the map can be called "near Del Mar, California" instead of a
 * pair of coordinates.
 */
export default new Action({
  name: 'Geo Reverse',
  description: 'Name the nearest town to a point',
  method: 'GET',
  async handle(request) {
    const { options } = parseGazetteerQuery(key => request.get(key))
    if (!options.proximity)
      return response.json({ success: false, error: 'lat and lng are required' }, 422)

    const gazetteer = openGazetteer()
    if (!gazetteer)
      return response.json({ success: true, available: false, results: [] })

    const results = gazetteer.reverseSync(options.proximity, { limit: 1 })
    return response.json({ success: true, available: true, results, attribution: GEONAMES_ATTRIBUTION })
  },
})

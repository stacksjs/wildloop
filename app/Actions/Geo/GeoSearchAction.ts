import { GEONAMES_ATTRIBUTION, parseGazetteerQuery } from 'ts-maps/gazetteer'
import { openGazetteer } from '../../Support/gazetteer'

/**
 * GET /api/geo/search?q=San Diego — towns and cities by name, for planning a
 * trip somewhere you are not.
 *
 * Answered from the GeoNames gazetteer on this server (ts-maps/gazetteer), so
 * what someone types never leaves it and there is no quota to run out of
 * while they type. Same `{ results }` shape as the ts-maps GazetteerGeocoder
 * expects, so a map's search box can point straight at this route.
 *
 * Before `buddy geo:import` has run there is nothing to search: that answers
 * `available: false` with no results rather than an error, and the page says
 * place search is not ready instead of "no matches".
 */
export default new Action({
  name: 'Geo Search',
  description: 'Search towns and cities by name',
  method: 'GET',
  async handle(request) {
    const { query, options } = parseGazetteerQuery(key => request.get(key))
    const gazetteer = openGazetteer()
    if (!gazetteer)
      return response.json({ success: true, available: false, results: [] })

    const results = gazetteer.searchSync(query, { ...options, limit: Math.min(options.limit ?? 6, 10) })
    return response.json({ success: true, available: true, results, attribution: GEONAMES_ATTRIBUTION })
  },
})

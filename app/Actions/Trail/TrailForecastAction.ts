// GET /api/trails/{id}/forecast - the week's weather at the trailhead.
//
// Public, like the trail itself. Cached per ~1 km in app/Support/trailForecast,
// so a crawler walking the catalog costs MET Norway one request per spot and
// forecast period, not one per page view.

import { FORECAST_ATTRIBUTION, FORECAST_ATTRIBUTION_URL, forecastFor } from '../../Support/trailForecast'

export default new Action({
  name: 'Trail Forecast',
  description: 'Seven-day weather forecast at a trail',
  method: 'GET',

  async handle(request) {
    const trailId = positiveInt(request.get('id'))
    if (!trailId)
      return response.json({ success: false, error: 'Trail ID is required' }, 422)

    const trail = await Trail.find(trailId)
    if (!trail)
      return response.json({ success: false, error: 'Trail not found' }, 404)

    const forecast = await forecastFor(Number(trail.latitude), Number(trail.longitude))
    if (!forecast || forecast.days.length === 0)
      return response.json({ success: false, error: 'No forecast is available for this trail right now.' }, 503)

    return response.json({
      success: true,
      ...forecast,
      attribution: { label: FORECAST_ATTRIBUTION, url: FORECAST_ATTRIBUTION_URL },
    })
  },
})

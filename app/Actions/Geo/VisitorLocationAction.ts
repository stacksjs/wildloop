// Auth is not needed here: this endpoint reports what the edge already knows
// about the request in front of it, which is the same for a signed-out visitor
// and a signed-in one.

import { visitorCountry, visitorLocation } from '../../Helpers/visitorCountry'

/**
 * GET /api/geo/here — where this request appears to be coming from.
 *
 * The browser's Geolocation API is more accurate, but it costs a permission
 * prompt, and a prompt on first paint is the fastest way to be told no for the
 * rest of the session. So the catalog opens on the edge's guess — good to a
 * city — and offers to get precise only when the visitor asks.
 *
 * Deliberately coarse. Nothing here is stored, and the response is a city
 * centroid, not the caller's address: it is the same value a CDN already put
 * in the request headers, handed back to the page that needs it.
 */
export default new Action({
  name: 'Visitor Location',
  description: 'Approximate location of the current request, from edge geo headers',
  method: 'GET',

  async handle(request) {
    const location = visitorLocation(request)

    if (!location) {
      // A country on its own is still worth returning: the catalog filters by
      // it, so knowing "DE" changes the page even when the city does not.
      return response.json({
        success: true,
        located: false,
        country: visitorCountry(request) ?? null,
      })
    }

    const { latitude, longitude, city, region, country } = location

    return response.json({
      success: true,
      located: true,
      lat: latitude,
      lng: longitude,
      city: city ?? null,
      region: region ?? null,
      country: country ?? null,
      label: [city, region].filter(Boolean).join(', ') || country || null,
    })
  },
})

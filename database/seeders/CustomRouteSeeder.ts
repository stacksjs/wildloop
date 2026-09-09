import { Seeder } from '@stacksjs/database'
import { haversineDistance } from '../../resources/functions/geo'
import { parseGpsData } from '../../resources/functions/gpx'
import Activity from '../../app/Models/Activity'
import CustomRoute from '../../app/Models/CustomRoute'
import { trailsByIds } from '../support/trails'

/**
 * Saved routes, so `/routes` is not a permanent "No saved routes yet."
 *
 * A custom route is a line an athlete saved for offline preparation, and the
 * page reads it back for the signed-in user only — which means an empty table
 * makes the page look identical whether the endpoint works or not.
 *
 * Each route here is one of the athlete's own recorded loops, saved as a
 * route. That is the honest source available: the catalog rows carry a
 * centroid rather than geometry (`trails.geometry` is empty until the OSM
 * ingest fills it), while the capture activities carry a real, verified track.
 * Distance and the closed-loop flag are measured off the points with the same
 * arithmetic CustomRouteStoreAction applies, rather than copied from the
 * activity, so a saved route describes itself.
 */

const METERS_PER_MILE = 1609.344
/** Same tolerance the store action uses to call a route a loop. */
const LOOP_GAP_METERS = 50

export default class CustomRouteSeeder extends Seeder {
  // After ActivitySeeder (-85): the routes are its tracks.
  static override order = -56

  async run(): Promise<void> {
    const activities = (await Activity.where('capture_eligible', '=', true).get().catch(() => [])) as any[]
    if (!activities.length) {
      console.warn('[seed] no recorded tracks; skipping custom routes')
      return
    }

    // Only the trails these recorded activities were run on.
    const trails = await trailsByIds((activities as any[]).map(activity => activity.trail_id))
    const trailById = new Map(trails.map(t => [t.id, t]))

    for (const activity of activities) {
      if (!activity.gpx_data)
        continue

      const coordinates = parseGpsData(activity.gpx_data)
      if (coordinates.length < 2)
        continue

      const trail = trailById.get(activity.trail_id)
      const name = trail?.name ? `${trail.name} — saved route` : `Recorded route #${activity.id}`

      let meters = 0
      for (let index = 1; index < coordinates.length; index++)
        meters += haversineDistance(coordinates[index - 1], coordinates[index])

      const payload = {
        user_id: activity.user_id,
        name,
        // `[lat, lng]` pairs, which is the shape the index action parses back.
        route_data: JSON.stringify(coordinates.map(point => [point.lat, point.lng])),
        distance: Math.round((meters / METERS_PER_MILE) * 100) / 100,
        elevation: activity.elevation ?? 0,
        closed_loop: haversineDistance(coordinates[0], coordinates[coordinates.length - 1]) <= LOOP_GAP_METERS,
      }

      // One saved route per athlete per name, so re-seeding refreshes the line
      // instead of filling the page with copies of the same loop.
      const existing = await CustomRoute
        .where('user_id', '=', activity.user_id)
        .where('name', '=', name)
        .first()
        .catch(() => null)

      if (existing)
        await CustomRoute.forceUpdate(existing.id, payload)
      else
        await CustomRoute.forceCreate(payload)
    }
  }
}

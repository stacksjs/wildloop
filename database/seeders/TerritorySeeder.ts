import { Seeder } from '@stacksjs/database'
import {
  calculatePerimeter,
  calculatePolygonArea,
  coordinatesToGeoJson,
  getBoundingBox,
  getCentroid,
  geoJsonToCoordinates,
  isClosedLoop,
  parseBoundingBox,
  polygonsOverlap,
  simplifyTrack,
} from '../../resources/functions/geo'
import { validateGpsDataForClaim, validateTrackRealism } from '../../resources/functions/gpx'
import Activity from '../../app/Models/Activity'
import Territory from '../../app/Models/Territory'
import TerritoryHistory from '../../app/Models/TerritoryHistory'
import { trailsByIds } from '../support/trails'

/**
 * The land the seeded athletes hold.
 *
 * This used to be `factory.generate(Territory, { count: 30 })`, which stopped
 * working when `factory` was removed from @stacksjs/database — so the map, the
 * territory leaderboard, the conquest feed and the battle board were all
 * empty, and `/territories` rendered its "no territory yet" state on a
 * database that was supposed to be full.
 *
 * Random polygons would not have fixed it. A territory is not a shape someone
 * drew: it is the land enclosed by a closed run, it belongs to the activity
 * that produced it, and every number on it (area, perimeter, centroid,
 * bounding box) is computed from that run's GPS ring. Faker rows satisfy the
 * columns and satisfy nothing else — thirty territories scattered over the
 * open ocean, owned by nobody who ran anything, with an area unrelated to
 * their own outline.
 *
 * So this seeder claims land the way the game does. It walks the
 * capture-eligible activities ActivitySeeder recorded, puts each one through
 * the same gates ClaimTerritoryAction applies — parseable track, realistic
 * track, closed loop, area inside the engine's band — and derives every column
 * with the same geo helpers the action calls. The result is land that the
 * capture engine could itself have produced, which is the only kind worth
 * testing a map against.
 *
 * Runs are walked oldest-first, and a run whose ring overlaps land that is
 * already held claims nothing — the engine answers that case with "Territory
 * overlaps existing land. Run through it to conquer instead", and it is the
 * same rule here. Those runs are the attacks and defences, and
 * TerritoryHistorySeeder resolves them against the parcel they landed on.
 *
 * The `claimed` history row is written here because a claim and its record are
 * one event; TerritoryHistorySeeder adds what happened to the land afterwards.
 */

/** Same band ClaimTerritoryAction enforces. */
const MIN_TERRITORY_SIZE = 1000
const MAX_TERRITORY_SIZE = 5000000

export default class TerritorySeeder extends Seeder {
  // After ActivitySeeder (-85): territories are claimed from its runs.
  static override order = -80

  async run(): Promise<void> {
    const captured = await Activity.where('capture_eligible', '=', true).get().catch(() => [])
    if (!(captured as any[])?.length) {
      console.warn('[seed] no capture-eligible activities; skipping territories')
      return
    }

    // Oldest first, so land is claimed in the order it was actually run and
    // the overlap rule below sees the same board the engine would have. `id`
    // only breaks ties between two runs finished at the same instant.
    const activities = [...(captured as any[])].sort((a, b) =>
      String(a.completed_at ?? '').localeCompare(String(b.completed_at ?? '')) || a.id - b.id)

    // The live board, kept in step as claims land so a run is measured against
    // everything claimed before it, not just what was in the table on entry.
    const live: Array<{ id: number, coordinates: Array<{ lat: number, lng: number }> }> = []
    for (const row of (await Territory.all().catch(() => [])) as any[]) {
      if (!['active', 'contested'].includes(row.status) || !row.polygon_data)
        continue
      live.push({ id: row.id, coordinates: geoJsonToCoordinates(row.polygon_data) })
    }

    // Only the trails these recorded activities were run on.
    const trails = await trailsByIds((activities as any[]).map(activity => activity.trail_id))
    const trailById = new Map((trails as any[]).map(t => [t.id, t]))

    for (const activity of activities as any[]) {
      if (!activity.gpx_data)
        continue

      const validation = validateGpsDataForClaim(activity.gpx_data)
      if (!validation.valid || !validation.coordinates) {
        console.warn(`[seed] activity ${activity.id} track rejected: ${validation.error}`)
        continue
      }

      const coordinates = validation.coordinates
      const realism = validateTrackRealism(coordinates)
      if (!realism.valid) {
        console.warn(`[seed] activity ${activity.id} track rejected: ${realism.error}`)
        continue
      }

      if (!isClosedLoop(coordinates)) {
        console.warn(`[seed] activity ${activity.id} does not close a loop; no land claimed`)
        continue
      }

      const simplified = simplifyTrack(coordinates)
      const area = calculatePolygonArea(simplified)
      if (area < MIN_TERRITORY_SIZE || area > MAX_TERRITORY_SIZE) {
        console.warn(`[seed] activity ${activity.id} encloses ${area.toFixed(0)} m², outside the claimable band`)
        continue
      }

      // The engine refuses a claim that overlaps live land and tells the
      // caller to conquer it instead. A run that lands on somebody's parcel is
      // therefore a battle, and TerritoryHistorySeeder picks it up from here.
      const overlapped = live.find(parcel => polygonsOverlap(simplified, parcel.coordinates))
      if (overlapped) {
        // Except when it is this run's own parcel from a previous seeding: the
        // claim is idempotent, so re-seeding has to refresh it rather than
        // mistake it for an attack on itself.
        const own = await Territory.where('activity_id', '=', activity.id).first().catch(() => null)
        if (!own || own.id !== overlapped.id)
          continue
      }

      const boundingBox = getBoundingBox(simplified)
      const bounds = parseBoundingBox(boundingBox)
      const centroid = getCentroid(simplified)

      // Named after the trail it was run on rather than `Territory #<epoch>`.
      // The engine has no better name available at claim time; a seed does,
      // and every screen that lists land reads better for it. The suffix
      // follows the model's own factory (`... Territory`) rather than "Loop",
      // which several of these trails are already called.
      const trail = trailById.get(activity.trail_id)
      const name = trail?.name ? `${trail.name} Territory` : `Territory #${activity.id}`
      const claimedAt = activity.completed_at ?? new Date().toISOString()

      const payload = {
        user_id: activity.user_id,
        activity_id: activity.id,
        parent_territory_id: null,
        name,
        polygon_data: coordinatesToGeoJson(simplified),
        bounding_box: boundingBox,
        min_lat: bounds.minLat,
        min_lng: bounds.minLng,
        max_lat: bounds.maxLat,
        max_lng: bounds.maxLng,
        center_lat: centroid.lat,
        center_lng: centroid.lng,
        area_size: area,
        perimeter: calculatePerimeter(simplified),
        // Conquests are TerritoryHistorySeeder's business; a fresh claim has
        // been fought over exactly zero times, and that seeder raises the
        // count on the parcels it changes hands.
        status: 'active' as const,
        conquest_count: 0,
        claimed_at: claimedAt,
        last_activity_at: claimedAt,
      }

      // One territory per activity is the engine's own idempotency rule (it
      // refuses a second claim from the same run), so re-seeding refreshes the
      // parcel rather than laying a duplicate over the top of it.
      const existing = await Territory.where('activity_id', '=', activity.id).first().catch(() => null)
      const territoryId = existing
        ? (await Territory.forceUpdate(existing.id, payload), existing.id)
        : (await Territory.forceCreate(payload),
          (await Territory.where('activity_id', '=', activity.id).first().catch(() => null))?.id)

      if (!territoryId)
        continue

      if (!live.some(parcel => parcel.id === territoryId))
        live.push({ id: territoryId, coordinates: simplified })

      const claim = await TerritoryHistory
        .where('activity_id', '=', activity.id)
        .where('event_type', '=', 'claimed')
        .first()
        .catch(() => null)

      const history = {
        territory_id: territoryId,
        user_id: activity.user_id,
        activity_id: activity.id,
        previous_owner_id: null,
        event_type: 'claimed' as const,
        area_at_event: area,
        previous_ownership_duration: null,
        notes: 'Initial claim',
        new_territory_id: null,
        created_at: claimedAt,
      }

      if (claim) {
        await TerritoryHistory.forceUpdate(claim.id, history)
      }
      else {
        await TerritoryHistory.forceCreate(history)
        // `useTimestamps` overwrites `created_at` on INSERT, so the date the
        // claim actually happened has to be written back after it.
        const created = await TerritoryHistory
          .where('activity_id', '=', activity.id)
          .where('event_type', '=', 'claimed')
          .first()
          .catch(() => null)
        if (created)
          await TerritoryHistory.forceUpdate(created.id, { created_at: claimedAt })
      }
    }
  }
}

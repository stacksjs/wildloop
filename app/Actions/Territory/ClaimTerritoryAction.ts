// NOTE: the ORM is snake_case end-to-end (rows + write payloads use column
// names like user_id / gpx_data / area_size). Reads and write keys below use
// snake_case accordingly; the JSON response keeps camelCase for API consumers.

import { Auth } from '@stacksjs/auth'

import { evaluateAchievementsForUser } from '../Achievement/EvaluateAchievementsAction'
import { recomputeTerritoryRanks } from './ComputeTerritoryRanksAction'
import UserPrivacySetting from '../../Models/UserPrivacySetting'

const MIN_TERRITORY_SIZE = 1000
const MAX_TERRITORY_SIZE = 5000000

export default new Action({
  name: 'Claim Territory',
  description: 'Claim a new territory from a completed activity with a closed loop GPS track',
  method: 'POST',

  async handle(request) {
    const activityId = positiveInt(request.get('activity_id'))
    // Acting user comes from the authenticated session (route is behind `auth`).
    // The body fallback only fires for in-process callers (the seed harness),
    // never over HTTP - so a client can't claim as another user.
    const userId = (await Auth.user().catch(() => null))?.id

    // Field validation (#977): malformed input → 422 with a field-keyed map.
    const fields: Record<string, string> = {}
    if (!activityId)
      fields.activity_id = 'required: a positive integer activity id'
    if (!userId)
      fields.user_id = 'required: authenticated session (or user_id in the harness)'
    if (Object.keys(fields).length)
      return response.json({ success: false, error: 'Validation failed', fields }, 422)

    try {
      const activity = await Activity.find(activityId)
      if (!activity) {
        return response.json({ success: false, error: 'Activity not found' }, 404)
      }

      if (activity.user_id !== userId) {
        return response.json({ success: false, error: 'Activity does not belong to user' }, 403)
      }

      if (!activity.capture_eligible || activity.game_mode !== 'capture') {
        return response.json({
          success: false,
          error: activity.integrity_reason || 'This activity is not eligible for territory capture',
          code: 'capture_ineligible',
        }, 422)
      }

      if (!activity.gpx_data) {
        return response.json({ success: false, error: 'Activity has no GPS data' }, 400)
      }

      const validation = validateGpsDataForClaim(activity.gpx_data)
      if (!validation.valid) {
        return response.json({ success: false, error: validation.error, code: 'not_a_loop' }, 400)
      }

      const coordinates = validation.coordinates!

      // Anti-cheat: reject fabricated tracks (teleport jumps / too short).
      const realism = validateTrackRealism(coordinates)
      if (!realism.valid) {
        return response.json({ success: false, error: realism.error, code: 'invalid_track' }, 400)
      }

      if (!isClosedLoop(coordinates)) {
        return response.json({
          success: false,
          error: 'No territory: your run did not finish within 50 m of where it started.',
          code: 'not_a_loop',
        }, 400)
      }

      // Closed explicitly: the track ends up to 50 m from where it began, and
      // the overlap and home-zone checks below walk the outline edge by edge,
      // so without the closing edge that last stretch was never checked.
      const simplified = simplifyTrack(coordinates)
      if (simplified[0].lat !== simplified[simplified.length - 1].lat || simplified[0].lng !== simplified[simplified.length - 1].lng)
        simplified.push(simplified[0])
      const area = calculatePolygonArea(simplified)

      // A home safety zone is stronger than route masking: it prevents a
      // territory polygon from being created around the protected location,
      // so the game itself cannot reveal where a run began or ended.
      const privacy = await UserPrivacySetting.where('user_id', '=', userId).first().catch(() => null)
      if (privacy?.exclude_home_from_game && privacy.home_lat != null && privacy.home_lng != null) {
        const home = { lat: privacy.home_lat, lng: privacy.home_lng }
        const radius = privacy.home_radius_meters ?? 500
        if (pointInPolygon(home, simplified) || distanceToRingMeters(home, simplified) <= radius) {
          return response.json({
            success: false,
            error: 'No territory: the loop comes within your protected home zone, and the game never draws one there.',
            code: 'privacy_zone',
          }, 422)
        }
      }

      if (area < MIN_TERRITORY_SIZE) {
        return response.json({
          success: false,
          error: `No territory: the loop encloses ${Math.round(area).toLocaleString('en-US')} m², and a claim needs at least ${MIN_TERRITORY_SIZE.toLocaleString('en-US')} m².`,
          code: 'too_small',
        }, 400)
      }

      if (area > MAX_TERRITORY_SIZE) {
        return response.json({
          success: false,
          error: `No territory: the loop encloses ${(area / 1_000_000).toFixed(1)} km², more than the ${MAX_TERRITORY_SIZE / 1_000_000} km² one claim can hold.`,
          code: 'too_large',
        }, 400)
      }

      const perimeter = calculatePerimeter(simplified)
      const centroid = getCentroid(simplified)
      const boundingBox = getBoundingBox(simplified)
      const bounds = parseBoundingBox(boundingBox)
      const polygonData = coordinatesToGeoJson(simplified)

      const xpGained = XP_REWARDS.claim(area)
      const now = new Date().toISOString()
      const { db } = await import('@stacksjs/database')
      const transactionResult = await (db as any).transaction(async (tx: any) => {
        // The idempotency read, overlap read, territory/history inserts, and
        // holdings counters share one serializable transaction. A concurrent
        // retry can no longer award XP twice or create overlapping land in the
        // gap between independent ORM writes.
        const priorClaim = await tx.selectFrom('territory_histories')
          .select(['id'])
          .where('activity_id', '=', activityId)
          .where('event_type', '=', 'claimed')
          .executeTakeFirst()
        const existingStats = await tx.selectFrom('territory_stats')
          .selectAll()
          .where('user_id', '=', userId)
          .executeTakeFirst()
        if (priorClaim) {
          return { alreadyProcessed: true, territory: null, previousXp: existingStats?.xp || 0 }
        }

        const candidates = await tx.selectFrom('territories').selectAll().execute()
        for (const candidate of candidates) {
          if (!['active', 'contested'].includes(candidate.status) || !candidate.polygon_data) continue
          if (polygonsOverlap(simplified, geoJsonToCoordinates(candidate.polygon_data)))
            return { overlap: true, ownLand: candidate.user_id === userId, territory: null, previousXp: existingStats?.xp || 0 }
        }

        await tx.insertInto('territories').values({
          user_id: userId,
          activity_id: activityId,
          parent_territory_id: null,
          name: `Territory #${Date.now()}`,
          polygon_data: polygonData,
          bounding_box: boundingBox,
          min_lat: bounds.minLat,
          min_lng: bounds.minLng,
          max_lat: bounds.maxLat,
          max_lng: bounds.maxLng,
          center_lat: centroid.lat,
          center_lng: centroid.lng,
          area_size: area,
          perimeter,
          status: 'active',
          conquest_count: 0,
          claimed_at: now,
          last_activity_at: now,
          created_at: now,
        }).execute()
        const territory = await tx.selectFrom('territories')
          .selectAll()
          .where('activity_id', '=', activityId)
          .orderBy('id', 'desc')
          .executeTakeFirst()
        if (!territory)
          throw new Error('Territory insert returned no row')

        await tx.insertInto('territory_histories').values({
          territory_id: territory.id,
          user_id: userId,
          activity_id: activityId,
          event_type: 'claimed',
          area_at_event: area,
          notes: 'Initial claim',
          created_at: now,
        }).execute()

        const previousXp = existingStats?.xp || 0
        if (existingStats) {
          await tx.updateTable('territory_stats').set({
            total_territories_owned: (existingStats.total_territories_owned || 0) + 1,
            total_area_owned: (existingStats.total_area_owned || 0) + area,
            territories_claimed: (existingStats.territories_claimed || 0) + 1,
            largest_territory_area: Math.max(existingStats.largest_territory_area || 0, area),
            xp: previousXp + xpGained,
            updated_at: now,
          }).where('id', '=', existingStats.id).execute()
        }
        else {
          await tx.insertInto('territory_stats').values({
            user_id: userId,
            total_territories_owned: 1,
            total_area_owned: area,
            territories_claimed: 1,
            territories_conquered: 0,
            territories_lost: 0,
            territories_defended: 0,
            longest_ownership_days: 0,
            largest_territory_area: area,
            xp: xpGained,
            weekly_rank: null,
            all_time_rank: null,
            created_at: now,
          }).execute()
        }
        return { territory, previousXp }
      }, { isolation: 'serializable', retries: 2 })

      if (transactionResult.alreadyProcessed)
        return response.json({ success: true, alreadyProcessed: true, xpGained: 0, totalXp: transactionResult.previousXp })
      if (transactionResult.overlap) {
        return response.json({
          success: false,
          // The conquest pass that follows a claim resolves any battle; this
          // only says why no new territory was drawn.
          error: transactionResult.ownLand
            ? 'No new territory: this loop overlaps ground you already hold.'
            : 'No new territory: this loop overlaps land someone else holds. Run across it to take part of it.',
          code: 'overlap',
        }, 409)
      }
      const territory = transactionResult.territory
      const prevXp = transactionResult.previousXp

      // Holdings changed - refresh persisted leaderboard ranks (#944).
      await recomputeTerritoryRanks().catch((err: unknown) =>
        console.error('Rank recompute after claim failed:', err))

      // Unlock engine hook (#982): owning land moves Empire Builder.
      await evaluateAchievementsForUser(userId).catch((err: unknown) =>
        console.error('[achievements] evaluate after claim failed:', err))

      return response.json({
        success: true,
        xpGained,
        totalXp: prevXp + xpGained,
        territory: {
          id: territory.id,
          name: territory.name,
          areaSize: territory.area_size,
          perimeter: territory.perimeter,
          centerLat: territory.center_lat,
          centerLng: territory.center_lng,
        },
      })
    }
    catch (error) {
      console.error('Error claiming territory:', error)
      return response.json({
        success: false,
        error: 'Failed to claim territory',
      }, 500)
    }
  },
})

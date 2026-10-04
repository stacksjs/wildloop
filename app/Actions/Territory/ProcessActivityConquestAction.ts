import { Auth } from '@stacksjs/auth'

import { evaluateAchievementsForUser } from '../Achievement/EvaluateAchievementsAction'
import { classifyBattleOutcome } from '../../../resources/functions/territory-battle'
import { recomputeTerritoryRanks } from './ComputeTerritoryRanksAction'
import { runTerritoryDecaySweep } from './DecayTerritoriesAction'
import { splitPieceName } from '../../Support/territoryNames'
import UserPrivacySetting from '../../Models/UserPrivacySetting'

const MIN_TERRITORY_SIZE = 1000

interface BattleResult {
  kind: 'skipped' | 'patrolled' | 'defended' | 'contested' | 'takeover' | 'split'
  xp: number
  territoryId: number
  territoryName: string
  previousOwner?: number
  conqueredArea?: number
  remainingArea?: number
  newTerritoryId?: number
}

/**
 * Resolve one verified capture activity against the live territory board.
 *
 * Each territory resolution is a serializable database transaction. The
 * resolution marker, polygon/owner mutation, history, holdings counters, and
 * XP either commit together or roll back together. A unique activity/territory
 * marker makes request retries and concurrent workers harmless.
 */
export default new Action({
  name: 'Process Activity Conquest',
  description: 'Resolve an activity against territories atomically',
  method: 'POST',

  async handle(request) {
    const activityId = positiveInt(request.get('activity_id'))
    const userId = (await Auth.user().catch(() => null))?.id
    const targetRaw = request.get('target_territory_id')
    const targetTerritoryId = targetRaw == null ? null : positiveInt(targetRaw)
    const fields: Record<string, string> = {}
    if (!activityId) fields.activity_id = 'required: a positive integer activity id'
    if (!userId) fields.user_id = 'required: an authenticated user'
    if (targetRaw != null && !targetTerritoryId)
      fields.target_territory_id = 'must be a positive integer territory id'
    if (Object.keys(fields).length)
      return response.json({ success: false, error: 'Validation failed', fields }, 422)

    try {
      const activity = await Activity.find(activityId)
      if (!activity)
        return response.json({ success: false, error: 'Activity not found' }, 404)
      if (activity.user_id !== userId)
        return response.json({ success: false, error: 'Activity does not belong to user' }, 403)
      if (!activity.capture_eligible || activity.game_mode !== 'capture') {
        return response.json({
          success: false,
          error: activity.integrity_reason || 'This activity is not eligible for territory capture',
          code: 'capture_ineligible',
        }, 422)
      }
      if (!activity.gpx_data)
        return response.json({ success: false, error: 'Activity has no GPS data' }, 400)

      const routeCoordinates = parseGpsData(activity.gpx_data)
      if (routeCoordinates.length < 2)
        return response.json({ success: false, error: 'Insufficient GPS data' }, 400)
      const realism = validateTrackRealism(routeCoordinates)
      if (!realism.valid)
        return response.json({ success: false, error: realism.error, code: 'invalid_track' }, 400)

      await runTerritoryDecaySweep().catch((error: unknown) =>
        console.error('Decay sweep before conquest failed:', error))

      const actor = await User.find(userId)
      const attackerPrivacy = await UserPrivacySetting.where('user_id', '=', userId).first().catch(() => null)
      const attackerHome: HomeZone | null = attackerPrivacy?.exclude_home_from_game && attackerPrivacy.home_lat != null && attackerPrivacy.home_lng != null
        ? { lat: Number(attackerPrivacy.home_lat), lng: Number(attackerPrivacy.home_lng), radius: Number(attackerPrivacy.home_radius_meters ?? 500) }
        : null
      const actorName = actor?.name ?? 'A rival runner'
      const routeBounds = parseBoundingBox(getBoundingBox(routeCoordinates))
      let candidates: any[]
      if (targetTerritoryId) {
        const target = await Territory.find(targetTerritoryId)
        candidates = target && ['active', 'contested'].includes(target.status) ? [target] : []
      }
      else {
        const indexed = await Territory.whereIn('status', ['active', 'contested'])
          .where('max_lat', '>=', routeBounds.minLat)
          .where('min_lat', '<=', routeBounds.maxLat)
          .where('max_lng', '>=', routeBounds.minLng)
          .where('min_lng', '<=', routeBounds.maxLng)
          .get()
        const legacy = await Territory.whereIn('status', ['active', 'contested'])
          .whereNull('min_lat')
          .get()
        const nearbyLegacy = (legacy ?? []).filter((territory: any) => {
          if (!territory.bounding_box) return false
          const bounds = parseBoundingBox(territory.bounding_box)
          return !(bounds.maxLat < routeBounds.minLat || bounds.minLat > routeBounds.maxLat
            || bounds.maxLng < routeBounds.minLng || bounds.minLng > routeBounds.maxLng)
        })
        candidates = [...(indexed ?? []), ...nearbyLegacy]
          .filter((territory, index, rows) => rows.findIndex(row => row.id === territory.id) === index)
      }

      const conquered: BattleResult[] = []
      const contested: Array<{ id: number, name: string }> = []
      const defended: Array<{ id: number, name: string }> = []
      const failedTerritoryIds: number[] = []
      let runXp = 0
      const { db } = await import('@stacksjs/database')

      for (const candidate of candidates ?? []) {
        try {
          const polygon = geoJsonToCoordinates(candidate.polygon_data)
          if (!routeIntersectsPolygon(routeCoordinates, polygon))
            continue

          const result = await (db as any).transaction(async (tx: any): Promise<BattleResult> => {
            const territory = await tx.selectFrom('territories')
              .selectAll()
              .where('id', '=', candidate.id)
              .executeTakeFirst()
            if (!territory || !['active', 'contested'].includes(territory.status))
              return skipped(candidate)

            const existing = await tx.selectFrom('territory_activity_resolutions')
              .select(['id'])
              .where('activity_id', '=', activityId)
              .where('territory_id', '=', territory.id)
              .executeTakeFirst()
            if (existing)
              return skipped(territory)

            const livePolygon = geoJsonToCoordinates(territory.polygon_data)
            if (!routeIntersectsPolygon(routeCoordinates, livePolygon))
              return skipped(territory)

            const now = new Date().toISOString()
            const base = {
              territoryId: territory.id,
              territoryName: territory.name,
            }

            if (territory.user_id === userId) {
              const kind = territory.status === 'contested' ? 'defended' : 'patrolled'
              await markResolution(tx, activityId, territory.id, kind, now)
              await tx.updateTable('territories').set({
                status: 'active',
                last_activity_at: now,
                updated_at: now,
              }).where('id', '=', territory.id).execute()
              if (kind === 'patrolled')
                return { ...base, kind, xp: 0 }

              const xp = XP_REWARDS.defend()
              await insertHistory(tx, {
                territory_id: territory.id,
                user_id: userId,
                activity_id: activityId,
                event_type: 'defended',
                area_at_event: territory.area_size,
                notes: 'Owner ran through contested territory',
                created_at: now,
              })
              await applyDefenseStats(tx, userId, xp, now)
              return { ...base, kind, xp }
            }

            const previousOwner = territory.user_id
            const ownershipDuration = territory.claimed_at
              ? Math.floor((Date.now() - new Date(territory.claimed_at).getTime()) / 1000)
              : 0
            const pieces = splitPolygonByRoute(livePolygon, routeCoordinates)
              .map((piece: any) => ({ polygon: piece, area: calculatePolygonArea(piece) }))
              .sort((a: any, b: any) => b.area - a.area)
            const keep = pieces[0]
            const captured = pieces[1]

            let kind: BattleResult['kind'] = classifyBattleOutcome(
              territory.area_size || 0,
              pieces.map((piece: any) => piece.area),
              MIN_TERRITORY_SIZE,
            )

            // The attacker's protected home zone holds for land they win as
            // it does for land they claim: no territory of theirs is drawn
            // there, so the attack stands as a contest.
            const inHomeZone = (kind === 'split' && reachesHome(attackerHome, captured.polygon))
              || (kind === 'takeover' && reachesHome(attackerHome, livePolygon))
            if (inHomeZone)
              kind = 'contested'

            // A territory already under attack does not emit duplicate contest
            // events, but the activity is still marked resolved for idempotency.
            if (kind === 'contested') {
              await markResolution(tx, activityId, territory.id, kind, now)
              if (territory.status === 'contested')
                return { ...base, kind: 'skipped', xp: 0 }
              await tx.updateTable('territories').set({ status: 'contested', updated_at: now })
                .where('id', '=', territory.id).execute()
              await insertHistory(tx, {
                territory_id: territory.id,
                user_id: userId,
                activity_id: activityId,
                event_type: 'contested',
                area_at_event: territory.area_size,
                notes: inHomeZone
                  ? 'Attack reached the protected home zone of the attacker, so no land changed hands'
                  : 'Attack intersected the territory without a valid split',
                created_at: now,
              })
              return { ...base, kind, xp: 0, previousOwner }
            }

            if (kind === 'takeover') {
              const area = territory.area_size || 0
              const xp = XP_REWARDS.conquest(area)
              await markResolution(tx, activityId, territory.id, kind, now)
              await tx.updateTable('territories').set({
                user_id: userId,
                status: 'active',
                conquest_count: (territory.conquest_count || 0) + 1,
                claimed_at: now,
                last_activity_at: now,
                updated_at: now,
              }).where('id', '=', territory.id).execute()
              await insertHistory(tx, {
                territory_id: territory.id,
                user_id: userId,
                activity_id: activityId,
                previous_owner_id: previousOwner,
                event_type: 'conquered',
                area_at_event: area,
                previous_ownership_duration: ownershipDuration,
                notes: 'Full territory conquest',
                created_at: now,
              })
              await applyConquestStats(tx, {
                conquerorId: userId,
                previousOwnerId: previousOwner,
                areaGained: area,
                areaLost: area,
                wholeTerritory: true,
                ownershipDurationSeconds: ownershipDuration,
                xp,
                now,
              })
              return {
                ...base,
                kind,
                xp,
                previousOwner,
                conqueredArea: area,
                remainingArea: 0,
              }
            }

            const keepBoundsText = getBoundingBox(keep.polygon)
            const keepBounds = parseBoundingBox(keepBoundsText)
            const keepCenter = getCentroid(keep.polygon)
            const capturedBoundsText = getBoundingBox(captured.polygon)
            const capturedBounds = parseBoundingBox(capturedBoundsText)
            const capturedCenter = getCentroid(captured.polygon)
            const xp = XP_REWARDS.conquest(captured.area)
            await markResolution(tx, activityId, territory.id, kind, now)
            await tx.updateTable('territories').set({
              polygon_data: coordinatesToGeoJson(keep.polygon),
              bounding_box: keepBoundsText,
              min_lat: keepBounds.minLat,
              min_lng: keepBounds.minLng,
              max_lat: keepBounds.maxLat,
              max_lng: keepBounds.maxLng,
              center_lat: keepCenter.lat,
              center_lng: keepCenter.lng,
              area_size: keep.area,
              perimeter: calculatePerimeter(keep.polygon),
              conquest_count: (territory.conquest_count || 0) + 1,
              status: 'active',
              updated_at: now,
            }).where('id', '=', territory.id).execute()
            await tx.insertInto('territories').values({
              user_id: userId,
              activity_id: activityId,
              parent_territory_id: territory.id,
              name: splitPieceName(territory.name),
              polygon_data: coordinatesToGeoJson(captured.polygon),
              bounding_box: capturedBoundsText,
              min_lat: capturedBounds.minLat,
              min_lng: capturedBounds.minLng,
              max_lat: capturedBounds.maxLat,
              max_lng: capturedBounds.maxLng,
              center_lat: capturedCenter.lat,
              center_lng: capturedCenter.lng,
              area_size: captured.area,
              perimeter: calculatePerimeter(captured.polygon),
              status: 'active',
              conquest_count: 1,
              claimed_at: now,
              last_activity_at: now,
              created_at: now,
            }).execute()
            const newTerritory = await tx.selectFrom('territories').selectAll()
              .where('activity_id', '=', activityId)
              .where('parent_territory_id', '=', territory.id)
              .orderBy('id', 'desc')
              .executeTakeFirst()
            if (!newTerritory)
              throw new Error('Split territory insert returned no row')

            await insertHistory(tx, {
              territory_id: territory.id,
              user_id: previousOwner,
              activity_id: activityId,
              event_type: 'split',
              area_at_event: keep.area,
              previous_ownership_duration: ownershipDuration,
              new_territory_id: newTerritory.id,
              notes: 'Territory split, retained portion',
              created_at: now,
            })
            await insertHistory(tx, {
              territory_id: newTerritory.id,
              user_id: userId,
              activity_id: activityId,
              previous_owner_id: previousOwner,
              event_type: 'conquered',
              area_at_event: captured.area,
              previous_ownership_duration: ownershipDuration,
              notes: 'Partial territory conquest',
              created_at: now,
            })
            await applyConquestStats(tx, {
              conquerorId: userId,
              previousOwnerId: previousOwner,
              areaGained: captured.area,
              areaLost: Math.max(0, (territory.area_size || 0) - keep.area),
              wholeTerritory: false,
              ownershipDurationSeconds: ownershipDuration,
              xp,
              now,
            })
            return {
              ...base,
              kind,
              xp,
              previousOwner,
              conqueredArea: captured.area,
              remainingArea: keep.area,
              newTerritoryId: newTerritory.id,
            }
          }, { isolation: 'serializable', retries: 2 })

          runXp += result.xp
          if (result.kind === 'defended') {
            defended.push({ id: result.territoryId, name: result.territoryName })
            await notify(userId, actor, 'conquest_defend', `You defended ${result.territoryName}!`, `/territory/${result.territoryId}`)
          }
          else if (result.kind === 'contested' && result.previousOwner) {
            contested.push({ id: result.territoryId, name: result.territoryName })
            await notify(result.previousOwner, actor, 'conquest_attack', `${actorName} is attacking ${result.territoryName}!`, `/territory/${result.territoryId}`)
          }
          else if ((result.kind === 'takeover' || result.kind === 'split') && result.previousOwner) {
            conquered.push(result)
            const amount = result.kind === 'split'
              ? `${Math.round(result.conqueredArea || 0).toLocaleString()} m² of `
              : ''
            await notify(result.previousOwner, actor, 'conquest_attack', `${actorName} conquered ${amount}${result.territoryName}!`, `/territory/${result.territoryId}`)
          }
        }
        catch (error) {
          console.error(`Error processing battle for territory #${candidate.id}:`, error)
          failedTerritoryIds.push(candidate.id)
        }
      }

      if (conquered.length)
        await recomputeTerritoryRanks().catch((error: unknown) => console.error('Rank recompute failed:', error))
      if (conquered.length || defended.length)
        await evaluateAchievementsForUser(userId).catch((error: unknown) => console.error('Achievement evaluation failed:', error))

      const totalXp = (await TerritoryStats.where('user_id', '=', userId).first())?.xp || 0
      if (failedTerritoryIds.length) {
        return response.json({
          success: false,
          error: 'Some territory battles could not be resolved and are safe to retry',
          retryable: true,
          failedTerritoryIds,
          xpGained: runXp,
          totalXp,
        }, 500)
      }
      return response.json({
        success: true,
        conqueredCount: conquered.length,
        territories: conquered.map(result => ({
          originalId: result.territoryId,
          originalOwner: result.previousOwner,
          conqueredArea: result.conqueredArea,
          remainingArea: result.remainingArea,
          newTerritoryId: result.newTerritoryId,
        })),
        contested,
        defended,
        xpGained: runXp,
        totalXp,
      })
    }
    catch (error) {
      console.error('Error processing conquest:', error)
      return response.json({ success: false, error: 'Failed to process conquest' }, 500)
    }
  },
})

interface HomeZone {
  lat: number
  lng: number
  radius: number
}

/** Whether land would sit in, or reach into, a protected home zone. */
function reachesHome(home: HomeZone | null, polygon: Array<{ lat: number, lng: number }> | undefined): boolean {
  if (!home || !polygon?.length)
    return false
  return pointInPolygon(home, polygon) || distanceToRingMeters(home, polygon) <= home.radius
}

function skipped(territory: any): BattleResult {
  return {
    kind: 'skipped',
    xp: 0,
    territoryId: territory.id,
    territoryName: territory.name,
  }
}

async function markResolution(tx: any, activityId: number, territoryId: number, outcome: string, now: string) {
  await tx.insertInto('territory_activity_resolutions').values({
    activity_id: activityId,
    territory_id: territoryId,
    outcome,
    created_at: now,
  }).execute()
}

async function insertHistory(tx: any, values: Record<string, unknown>) {
  await tx.insertInto('territory_histories').values(values).execute()
}

async function applyDefenseStats(tx: any, userId: number, xp: number, now: string) {
  const stats = await tx.selectFrom('territory_stats').selectAll().where('user_id', '=', userId).executeTakeFirst()
  if (stats) {
    await tx.updateTable('territory_stats').set({
      territories_defended: (stats.territories_defended || 0) + 1,
      xp: (stats.xp || 0) + xp,
      updated_at: now,
    }).where('id', '=', stats.id).execute()
    return
  }
  await tx.insertInto('territory_stats').values(emptyStats(userId, now, {
    territories_defended: 1,
    xp,
  })).execute()
}

async function applyConquestStats(tx: any, update: {
  conquerorId: number
  previousOwnerId: number
  areaGained: number
  areaLost: number
  wholeTerritory: boolean
  ownershipDurationSeconds: number
  xp: number
  now: string
}) {
  const conqueror = await tx.selectFrom('territory_stats').selectAll()
    .where('user_id', '=', update.conquerorId).executeTakeFirst()
  if (conqueror) {
    await tx.updateTable('territory_stats').set({
      total_territories_owned: (conqueror.total_territories_owned || 0) + 1,
      total_area_owned: (conqueror.total_area_owned || 0) + update.areaGained,
      territories_conquered: (conqueror.territories_conquered || 0) + 1,
      largest_territory_area: Math.max(conqueror.largest_territory_area || 0, update.areaGained),
      xp: (conqueror.xp || 0) + update.xp,
      updated_at: update.now,
    }).where('id', '=', conqueror.id).execute()
  }
  else {
    await tx.insertInto('territory_stats').values(emptyStats(update.conquerorId, update.now, {
      total_territories_owned: 1,
      total_area_owned: update.areaGained,
      territories_conquered: 1,
      largest_territory_area: update.areaGained,
      xp: update.xp,
    })).execute()
  }

  const previous = await tx.selectFrom('territory_stats').selectAll()
    .where('user_id', '=', update.previousOwnerId).executeTakeFirst()
  if (!previous)
    return
  const ownershipDays = Math.floor(update.ownershipDurationSeconds / 86400)
  await tx.updateTable('territory_stats').set({
    total_territories_owned: update.wholeTerritory
      ? Math.max(0, (previous.total_territories_owned || 0) - 1)
      : previous.total_territories_owned || 0,
    total_area_owned: Math.max(0, (previous.total_area_owned || 0) - update.areaLost),
    territories_lost: (previous.territories_lost || 0) + (update.wholeTerritory ? 1 : 0),
    longest_ownership_days: update.wholeTerritory
      ? Math.max(previous.longest_ownership_days || 0, ownershipDays)
      : previous.longest_ownership_days || 0,
    updated_at: update.now,
  }).where('id', '=', previous.id).execute()
}

function emptyStats(userId: number, now: string, overrides: Record<string, unknown>) {
  return {
    user_id: userId,
    total_territories_owned: 0,
    total_area_owned: 0,
    territories_claimed: 0,
    territories_conquered: 0,
    territories_lost: 0,
    territories_defended: 0,
    longest_ownership_days: 0,
    largest_territory_area: 0,
    weekly_rank: null,
    all_time_rank: null,
    xp: 0,
    created_at: now,
    ...overrides,
  }
}

/** Best-effort notification: a push/feed failure cannot roll back a battle. */
async function notify(recipientId: number, actor: any, type: string, body: string, link: string) {
  try {
    await UserNotification.forceCreate({
      recipient_id: recipientId,
      actor_id: actor?.id ?? recipientId,
      actor_name: actor?.name ?? 'Someone',
      type,
      body,
      link,
      read: false,
    })
  }
  catch (error) {
    console.error('Failed to write battle notification:', error)
  }
}

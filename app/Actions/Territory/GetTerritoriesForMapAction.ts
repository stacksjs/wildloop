// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// NOTE: the ORM is snake_case (rows expose column names). Model reads below use
// snake_case; the GeoJSON properties keep camelCase for the map/frontend.
import { Auth } from '@stacksjs/auth'

import UserPrivacySetting from '../../Models/UserPrivacySetting'
import { mapBoundsFromQuery } from '../../../resources/functions/map-area'
import { territoryFeature } from '../../Support/territoryFeatures'

export default new Action({
  name: 'Get Territories For Map',
  description: 'Get territories within a bounding box for map display',
  method: 'GET',

  async handle(request) {
    const bounds = mapBoundsFromQuery(key => request.get(key))
    const currentUserId = (await Auth.user().catch(() => null))?.id ?? null
    const limit = Math.min(500, Math.max(1, Number(request.get<number>('limit') || 100)))

    try {
      // Contested territories are still on the map - they're the interesting
      // ones (under attack). Only future non-live states would be excluded.
      let filteredTerritories: any[]
      if (bounds) {
        const { minLat, minLng, maxLat, maxLng } = bounds
        // Spatial columns are indexed and applied before LIMIT. Legacy rows
        // without the columns are repaired as they are encountered below.
        const indexed = await Territory.whereIn('status', ['active', 'contested'])
          .where('max_lat', '>=', minLat)
          .where('min_lat', '<=', maxLat)
          .where('max_lng', '>=', minLng)
          .where('min_lng', '<=', maxLng)
          .limit(limit)
          .get()
        const legacy = await Territory.whereIn('status', ['active', 'contested'])
          .whereNull('min_lat')
          .get()
        const repaired: any[] = []
        for (const territory of legacy ?? []) {
          if (!territory.bounding_box) continue
          const bbox = parseBoundingBox(territory.bounding_box)
          await Territory.forceUpdate(territory.id, {
            min_lat: bbox.minLat,
            min_lng: bbox.minLng,
            max_lat: bbox.maxLat,
            max_lng: bbox.maxLng,
          }).catch(() => undefined)
          if (!(bbox.maxLat < minLat || bbox.minLat > maxLat
            || bbox.maxLng < minLng || bbox.minLng > maxLng)
          ) repaired.push(territory)
        }
        filteredTerritories = [...(indexed ?? []), ...repaired]
          .filter((territory, index, rows) => rows.findIndex(row => row.id === territory.id) === index)
          .slice(0, limit)
      }
      else {
        filteredTerritories = await Territory.whereIn('status', ['active', 'contested']).limit(limit).get()
      }

      const userIds = [...new Set(filteredTerritories.map((t: any) => t.user_id))]
      const users = await User.whereIn('id', userIds).get()
      const userMap = new Map(users.map((u: any) => [u.id, u]))
      const settingsRows = userIds.length
        ? (await UserPrivacySetting.whereIn('user_id', userIds).get().catch(() => [])) ?? []
        : []
      const settingsMap = new Map(settingsRows.map((row: any) => [row.user_id, row]))
      const blockedIds = await blockedUserIdsFor(currentUserId)

      // Defense counts come from the history log (the 'defended' events #941
      // writes), so the map can show real defend tallies per territory.
      const territoryIds = filteredTerritories.map((territory: any) => territory.id)
      const defendRows = territoryIds.length
        ? (await TerritoryHistory.where('event_type', '=', 'defended').whereIn('territory_id', territoryIds).get()) ?? []
        : []
      const defendCounts = new Map<number, number>()
      for (const row of defendRows)
        defendCounts.set(row.territory_id, (defendCounts.get(row.territory_id) ?? 0) + 1)

      const features = filteredTerritories
        .filter((t: any) => !blockedIds.has(t.user_id))
        .map((t: any) => territoryFeature(t, {
          viewerId: currentUserId,
          owner: userMap.get(t.user_id),
          ownerSettings: settingsMap.get(t.user_id),
          defendCount: defendCounts.get(t.id) ?? 0,
        }))
        .filter(f => f.geometry !== null)

      return response.json({
        success: true,
        type: 'FeatureCollection',
        features,
        meta: {
          total: features.length,
          bounds,
        },
      })
    }
    catch (error) {
      console.error('Error fetching territories for map:', error)
      return response.json({
        success: false,
        type: 'FeatureCollection',
        features: [],
        error: 'Failed to fetch territories',
      }, 500)
    }
  },
})

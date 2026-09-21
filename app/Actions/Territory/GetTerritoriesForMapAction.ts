// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// NOTE: the ORM is snake_case (rows expose column names). Model reads below use
// snake_case; the GeoJSON properties keep camelCase for the map/frontend.
import { Auth } from '@stacksjs/auth'

import UserPrivacySetting from '../../Models/UserPrivacySetting'

export default new Action({
  name: 'Get Territories For Map',
  description: 'Get territories within a bounding box for map display',
  method: 'GET',

  async handle(request) {
    const minLat = request.get<number>('min_lat')
    const minLng = request.get<number>('min_lng')
    const maxLat = request.get<number>('max_lat')
    const maxLng = request.get<number>('max_lng')
    const currentUserId = (await Auth.user().catch(() => null))?.id ?? null
    const limit = Math.min(500, Math.max(1, Number(request.get<number>('limit') || 100)))

    try {
      // Contested territories are still on the map - they're the interesting
      // ones (under attack). Only future non-live states would be excluded.
      const hasBounds = [minLat, minLng, maxLat, maxLng].every(value => typeof value === 'number' && Number.isFinite(value))
      let filteredTerritories: any[]
      if (hasBounds) {
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

      const features = filteredTerritories.filter((t: any) => !blockedIds.has(t.user_id)).map((t: any) => {
        const owner = userMap.get(t.user_id)
        const isOwned = currentUserId ? t.user_id === currentUserId : false

        let geometry
        try {
          geometry = JSON.parse(t.polygon_data)
        }
        catch {
          geometry = null
        }
        const ownerSettings = settingsMap.get(t.user_id)
        const canSeePrecise = isOwned || ownerSettings?.show_precise_territories
        if (geometry && !canSeePrecise && t.bounding_box) {
          const bbox = parseBoundingBox(t.bounding_box)
          geometry = {
            type: 'Polygon',
            coordinates: [[
              [bbox.minLng, bbox.minLat],
              [bbox.maxLng, bbox.minLat],
              [bbox.maxLng, bbox.maxLat],
              [bbox.minLng, bbox.maxLat],
              [bbox.minLng, bbox.minLat],
            ]],
          }
        }

        return {
          type: 'Feature',
          properties: {
            id: t.id,
            name: t.name,
            ownerId: t.user_id,
            ownerName: owner?.name || 'Unknown',
            isOwned,
            areaSize: t.area_size,
            perimeter: t.perimeter,
            conquestCount: t.conquest_count,
            defendCount: defendCounts.get(t.id) ?? 0,
            claimedAt: t.claimed_at,
            status: t.status,
            centerLat: t.center_lat,
            centerLng: t.center_lng,
            preciseGeometry: canSeePrecise,
          },
          geometry,
        }
      }).filter(f => f.geometry !== null)

      return response.json({
        success: true,
        type: 'FeatureCollection',
        features,
        meta: {
          total: features.length,
          bounds: minLat !== undefined ? { minLat, minLng, maxLat, maxLng } : null,
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

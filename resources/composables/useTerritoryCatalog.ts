import { onMount, state } from 'stx'
import { apiFetch } from '../assets/scripts/auth'

/**
 * Hydrate the `wl` store's territories from the live API
 * (`GET /api/territories/map`), mirroring useTrailCatalog for trails. Falls back
 * silently to seed data when the API is empty/unreachable.
 */

interface TerritoryStoreLike {
  territories: () => unknown[]
  hydrateTerritoriesFromApi: (
    territories: unknown[],
    polygons: Record<number, [number, number][]>,
    users: unknown[],
  ) => void
}

interface MapFeature {
  properties: {
    id: number
    name: string
    ownerId: number
    ownerName: string
    areaSize: number
    conquestCount: number
    defendCount: number
    claimedAt: string
    status: string
    centerLat: number
    centerLng: number
  }
  geometry: { type: string, coordinates: number[][][] } | null
}

export const territorySource = state<'api' | 'seed'>('seed')
export const territoryError = state<string | null>(null)

let territoriesStarted = false

/**
 * Fetch territories from the API and hydrate the store. Callable any time -
 * on boot AND after a run records a claim/conquest, so the map reflects the
 * backend's authoritative ownership rather than any client-side guess (#943).
 * Returns true if live data was applied.
 */
export interface TerritoryViewport {
  minLat: number
  minLng: number
  maxLat: number
  maxLng: number
}

export async function loadTerritories(
  wl: TerritoryStoreLike | null,
  viewport?: TerritoryViewport,
): Promise<boolean> {
  if (!wl)
    return false
  try {
    const query = new URLSearchParams({ limit: '500' })
    if (viewport) {
      query.set('min_lat', String(viewport.minLat))
      query.set('min_lng', String(viewport.minLng))
      query.set('max_lat', String(viewport.maxLat))
      query.set('max_lng', String(viewport.maxLng))
    }
    const res = await apiFetch(`/api/territories/map?${query}`, {
    })
    if (!res.ok)
      throw new Error(`Territories API returned ${res.status}`)
    const payload = await res.json()
    const features: MapFeature[] = Array.isArray(payload?.features) ? payload.features : []

    // An empty answer is an answer. This used to `return false` here, which
    // left the store's built-in demo territories on screen — so a player with
    // no claimed land saw "Cascade Ridge Zone" and "Summit Kingdom" owned by
    // people who do not exist, and the game could never show the honest empty
    // state that tells them to go and record a loop.
    if (!features.length) {
      wl.hydrateTerritoriesFromApi([], {}, [])
      territorySource.set('api')
      return true
    }

    const territories: any[] = []
    const polygons: Record<number, [number, number][]> = {}
    const usersById = new Map<number, any>()

    for (const f of features) {
      const p = f.properties
      territories.push({
        id: p.id,
        name: p.name,
        user_id: p.ownerId,
        areaSize: p.areaSize ?? 0,
        conquestCount: p.conquestCount ?? 0,
        defendCount: p.defendCount ?? 0,
        totalRunners: 0,
        status: p.status === 'contested' ? 'contested' : 'active',
        claimedAt: p.claimedAt ?? new Date().toISOString(),
        lat: p.centerLat ?? 0,
        lng: p.centerLng ?? 0,
      })

      // GeoJSON polygon ring is [[lng, lat], ...]; the store wants [lat, lng].
      const ring = f.geometry?.coordinates?.[0]
      if (ring)
        polygons[p.id] = ring.map(([lng, lat]) => [lat, lng] as [number, number])

      if (!usersById.has(p.ownerId)) {
        usersById.set(p.ownerId, {
          id: p.ownerId,
          name: p.ownerName || 'Unknown',
          email: '',
          avatar: null,
          joinedAt: new Date().toISOString(),
        })
      }
    }

    wl.hydrateTerritoriesFromApi(territories, polygons, [...usersById.values()])
    territorySource.set('api')
    return true
  }
  catch (err) {
    territoryError.set(err instanceof Error ? err.message : 'Could not load territories')
    territorySource.set('seed')
    return false
  }
}

export function useTerritoryCatalog(wl: TerritoryStoreLike | null) {
  onMount(async () => {
    if (!wl || territoriesStarted)
      return
    territoriesStarted = true
    await loadTerritories(wl)
  })
}

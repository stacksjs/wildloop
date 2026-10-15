import { onMount, state } from 'stx'
import { apiFetch } from '../assets/scripts/auth'
import { territoriesMapPath, territoryRowsFrom, type TerritoryRow } from '../functions/territories'

/**
 * Hydrate the `wl` store's territories from the live API
 * (`GET /api/territories/map`), mirroring useTrailCatalog for trails. The store
 * starts empty: an empty answer is shown as one, and an unreachable API sets
 * `territoryError` rather than leaving demo land on the map.
 */

interface TerritoryStoreLike {
  territories: () => unknown[]
  hydrateTerritoriesFromApi: (
    territories: unknown[],
    polygons: Record<number, [number, number][]>,
    users: unknown[],
  ) => void
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
    // `territoriesMapPath` rather than a `URLSearchParams` built here: the
    // native screen issues the same query and has no `URLSearchParams`, and
    // one of the two building it by hand is how the two drift.
    const res = await apiFetch(territoriesMapPath(viewport ?? null), {})
    if (!res.ok)
      throw new Error(`Territories API returned ${res.status}`)
    const payload = await res.json()
    const features = territoryRowsFrom(payload)
    territoryError.set(null)

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

    for (const row of features) {
      territories.push(storeTerritory(row))
      if (row.ring)
        polygons[row.id] = row.ring
      if (!usersById.has(row.userId))
        usersById.set(row.userId, storeOwner(row))
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

/** A shared row as the store holds it: snake_case, from the database days. */
function storeTerritory(row: TerritoryRow) {
  return {
    id: row.id,
    name: row.name,
    user_id: row.userId,
    areaSize: row.areaSize,
    conquestCount: row.conquestCount,
    defendCount: row.defendCount,
    totalRunners: 0,
    status: row.status,
    claimedAt: row.claimedAt || new Date().toISOString(),
    lat: row.lat,
    lng: row.lng,
  }
}

function storeOwner(row: TerritoryRow) {
  return {
    id: row.userId,
    name: row.ownerName || 'Unknown',
    email: '',
    avatar: row.ownerAvatar,
    joinedAt: new Date().toISOString(),
  }
}

/**
 * Fetch one territory into the store, for a page opened on it directly.
 *
 * The store holds the land around wherever the map last looked, so a
 * territory reached from a notification or a shared link is usually not in
 * it. Answers whether the territory exists, or null when the API could not
 * say.
 */
export async function loadTerritory(
  wl: (TerritoryStoreLike & { upsertTerritoryFromApi: (territory: unknown, polygon: [number, number][] | null, owner: unknown) => void }) | null,
  id: number,
): Promise<boolean | null> {
  if (!wl || !(id > 0))
    return false
  try {
    const res = await apiFetch(`/api/territories/${id}`, {})
    if (res.status === 404 || res.status === 422)
      return false
    if (!res.ok)
      return null
    const payload = await res.json()
    // Shaped through the same reader as the map, which wants a feature list.
    const [row] = territoryRowsFrom({ features: payload?.territory ? [payload.territory] : [] })
    if (!row)
      return false
    wl.upsertTerritoryFromApi(storeTerritory(row), row.ring, storeOwner(row))
    return true
  }
  catch {
    return null
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

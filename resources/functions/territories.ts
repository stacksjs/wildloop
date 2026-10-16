/**
 * The territory map, as both screens read it.
 *
 * `/api/territories/map` answers GeoJSON-ish features: a `properties` bag of
 * scalars and a `geometry` whose ring is `[[lng, lat], …]`. Everything the web
 * page and the native screen do with that — reorder the ring, filter, rank the
 * holders, name what a zone is — lives here so the two cannot drift.
 *
 * Extracted when `/territories` was promoted to a native screen. The drawing
 * is not shared: the web page uses ts-maps and the native screen uses craft's
 * `Map`, and only one of them knows what a tile is.
 *
 * Nothing here may touch a web API. The query is built with
 * `encodeURIComponent` rather than `URLSearchParams`, which the native runtime
 * does not define — `useTerritoryCatalog` builds the same string with
 * `URLSearchParams`, and that is exactly why this module exists separately.
 *
 * @module functions/territories
 */

import type { MapBounds } from './map-area'
import { pathIdFrom } from './route-id'

/** How many zones to ask for. The map holds the land around one viewport. */
export const TERRITORY_LIMIT = 500

export const TERRITORY_FILTERS = ['all', 'mine', 'contested'] as const
export type TerritoryFilter = typeof TERRITORY_FILTERS[number]

export const TERRITORY_FILTER_LABELS: Record<TerritoryFilter, string> = {
  all: 'All',
  mine: 'Mine',
  contested: 'Contested',
}

/** One zone, flattened out of a map feature. */
export interface TerritoryRow {
  id: number
  name: string
  userId: number
  ownerName: string
  /** Carried so the web store's roster keeps the avatar it used to hold. */
  ownerAvatar: string | null
  areaSize: number
  conquestCount: number
  defendCount: number
  status: 'active' | 'contested'
  claimedAt: string
  lat: number
  lng: number
  /** The boundary as `[lat, lng]` pairs, or null when the feature carried none. */
  ring: [number, number][] | null
}

/**
 * The map query, with an optional viewport.
 *
 * Built by hand rather than with `URLSearchParams`: a native screen has
 * neither, and a screen that issues no request at all is the failure mode that
 * taught us (see the shared-module rule in CLAUDE.md).
 */
export function territoriesMapPath(viewport?: MapBounds | null): string {
  let path = `/api/territories/map?limit=${TERRITORY_LIMIT}`
  if (viewport) {
    path += `&min_lat=${encodeURIComponent(String(viewport.minLat))}`
    path += `&min_lng=${encodeURIComponent(String(viewport.minLng))}`
    path += `&max_lat=${encodeURIComponent(String(viewport.maxLat))}`
    path += `&max_lng=${encodeURIComponent(String(viewport.maxLng))}`
  }
  return path
}

export function territoryPath(id: number): string {
  return `/api/territories/${encodeURIComponent(String(id))}`
}

/**
 * Map features as rows.
 *
 * A ring arrives as `[[lng, lat], …]` — GeoJSON order — and everything that
 * draws it wants `[lat, lng]`. Getting that backwards puts San Diego in the
 * Indian Ocean without erroring, so the swap happens once, here.
 */
export function territoryRowsFrom(payload: unknown): TerritoryRow[] {
  const features = (payload as any)?.features
  if (!Array.isArray(features))
    return []

  const rows: TerritoryRow[] = []
  for (const feature of features) {
    const properties = feature?.properties
    if (!properties || properties.id == null)
      continue

    const ring = feature?.geometry?.coordinates?.[0]
    rows.push({
      id: Number(properties.id),
      name: String(properties.name ?? `Territory #${properties.id}`),
      userId: Number(properties.ownerId ?? 0),
      ownerName: String(properties.ownerName || 'Unknown athlete'),
      ownerAvatar: properties.ownerAvatar ?? null,
      areaSize: Number(properties.areaSize ?? 0),
      conquestCount: Number(properties.conquestCount ?? 0),
      defendCount: Number(properties.defendCount ?? 0),
      status: properties.status === 'contested' ? 'contested' : 'active',
      claimedAt: String(properties.claimedAt ?? ''),
      lat: Number(properties.centerLat ?? 0),
      lng: Number(properties.centerLng ?? 0),
      ring: Array.isArray(ring)
        ? ring
            .filter((pair: unknown) => Array.isArray(pair) && pair.length >= 2)
            .map(([lng, lat]: [number, number]) => [Number(lat), Number(lng)] as [number, number])
        : null,
    })
  }
  return rows
}

/**
 * A ring as the flat `[lat, lng, …]` array a `MapPolyline` takes.
 *
 * craft-native draws polylines and markers; there is no polygon primitive, so
 * a zone is a polyline closed by repeating its first point. A ring that
 * already closes itself is left alone rather than given a duplicate point.
 */
export function territoryGeometry(ring: [number, number][] | null | undefined): number[] {
  if (!ring || ring.length < 2)
    return []

  const points = [...ring]
  const [firstLat, firstLng] = points[0]
  const [lastLat, lastLng] = points[points.length - 1]
  if (firstLat !== lastLat || firstLng !== lastLng)
    points.push([firstLat, firstLng])

  const flat: number[] = []
  for (const [lat, lng] of points)
    flat.push(lat, lng)
  return flat
}

export function matchesTerritoryFilter(
  territory: TerritoryRow,
  filter: TerritoryFilter,
  viewerId: number | null | undefined,
): boolean {
  if (filter === 'mine')
    return viewerId != null && territory.userId === viewerId
  if (filter === 'contested')
    return territory.status === 'contested'
  return true
}

export function filterTerritories(
  territories: TerritoryRow[],
  filter: TerritoryFilter,
  viewerId: number | null | undefined,
): TerritoryRow[] {
  return territories.filter(territory => matchesTerritoryFilter(territory, filter, viewerId))
}

export interface TerritoryHolder {
  userId: number
  userName: string
  zones: number
  area: number
  rank: number
}

/**
 * Who holds the land in view.
 *
 * Built from the territories themselves rather than from a roster of athletes:
 * starting from every known user listed strangers each holding "0 zones", which
 * is how the web page used to greet a player with no land nearby.
 */
export function territoryLeaderboard(territories: TerritoryRow[], limit = 10): TerritoryHolder[] {
  const held = new Map<number, { zones: number, area: number, name: string }>()
  for (const territory of territories) {
    const current = held.get(territory.userId) ?? { zones: 0, area: 0, name: territory.ownerName }
    held.set(territory.userId, {
      zones: current.zones + 1,
      area: current.area + (territory.areaSize || 0),
      name: current.name || territory.ownerName,
    })
  }

  return [...held.entries()]
    .map(([userId, holding]) => ({ userId, userName: holding.name, zones: holding.zones, area: holding.area }))
    // Area first, then id, so the order is the same on every client rather
    // than whatever order the map happened to load.
    .sort((a, b) => b.area - a.area || a.userId - b.userId)
    .slice(0, limit)
    .map((holder, index) => ({ ...holder, rank: index + 1 }))
}

/** Whose it is, in one word. */
export function territoryBadge(territory: TerritoryRow, viewerId: number | null | undefined): string {
  if (viewerId != null && territory.userId === viewerId)
    return 'Yours'
  return territory.status === 'contested' ? 'Contested' : 'Enemy'
}

export function territoryOwnerLine(territory: TerritoryRow, viewerId: number | null | undefined): string {
  return viewerId != null && territory.userId === viewerId ? 'You' : territory.ownerName
}

export function zonesHeldText(zones: number): string {
  return zones === 1 ? '1 zone held' : `${zones} zones held`
}

export function territoryEmptyTitle(filter: TerritoryFilter): string {
  return filter === 'contested' ? 'Nothing contested right now' : 'No territories yet'
}

export function territoryEmptyBody(filter: TerritoryFilter): string {
  return filter === 'contested'
    ? 'Every zone in view is held without a fight.'
    : 'Run a closed loop to claim your first territory.'
}

/**
 * One zone, from `/api/territories/{id}`.
 *
 * `TerritoryShowAction` answers "shaped exactly like a feature from
 * /api/territories/map", so it is read through the same function rather than a
 * second one that could disagree about the ring order.
 */
export function territoryFrom(payload: unknown): TerritoryRow | null {
  const feature = (payload as any)?.territory
  const [row] = territoryRowsFrom({ features: feature ? [feature] : [] })
  return row ?? null
}

/** Whether a zone is the viewer's own. Nobody owns anything when nobody is signed in. */
export function isOwnTerritory(territory: TerritoryRow | null, viewerId: number | null | undefined): boolean {
  return Boolean(territory && viewerId != null && viewerId > 0 && territory.userId === viewerId)
}

/** The hero line: whose ground this is, in the second person where it applies. */
export function territoryHolderLine(territory: TerritoryRow | null, viewerId: number | null | undefined): string {
  if (!territory)
    return ''
  if (isOwnTerritory(territory, viewerId))
    return 'Held by you'
  return territory.ownerName ? `Held by ${territory.ownerName}` : 'Held by nobody yet'
}

/** Secure or contested, which is the thing an owner wants to know first. */
export function territoryStandingText(territory: TerritoryRow | null): string {
  if (!territory)
    return ''
  return territory.status === 'contested' ? 'Contested' : 'Secure'
}

/**
 * What to do about it, which depends on whose it is.
 *
 * The web page's button goes to `/record` either way; the words are what
 * change, and they are the whole point of the button.
 */
export function territoryActionLabel(territory: TerritoryRow | null, viewerId: number | null | undefined): string {
  return isOwnTerritory(territory, viewerId) ? 'Defend it' : 'Conquer this'
}

/**
 * A territory id from a route parameter, or null.
 *
 * Kept as a name of its own because that is what the territory screens read;
 * the rule itself is shared (`functions/route-id`), since every parameterised
 * record page needs the same strictness.
 */
export function territoryIdFrom(raw: unknown): number | null {
  return pathIdFrom(raw)
}

/**
 * Trail API ↔ UI normalization (Stacks ORM uses camelCase in JSON).
 */

import { displayTrailTime } from '../../functions/trail-time'

export type LatLng = [number, number]

export interface UiTrail {
  id: number
  name: string
  location: string
  difficulty: 'easy' | 'moderate' | 'hard'
  /** Miles. Stored in miles too - see the note on `normalizeTrailRow`. */
  distance: number
  /** Feet of ascent. */
  elevation: number
  estimatedTime: string
  rating: number
  reviewCount: number
  description: string
  lat: number
  lng: number
  image: string | null
  tags: string[]
  conditions: string
  /** Two-letter USPS code, from the national ingest. Empty for older rows. */
  state: string
  /** Park, forest or district that administers the trail. */
  managedBy: string
  routeType: 'loop' | 'out-and-back' | 'point-to-point' | 'network' | ''
  surface: string
  /** Which public dataset this row came from, for attribution. */
  source: string
  sourceUrl: string
  nationalTrail: boolean
}

/** Parse stored geometry JSON: [[lat,lng],...] */
export function parseTrailGeometry(raw: unknown): LatLng[] {
  if (!raw)
    return []
  if (Array.isArray(raw)) {
    return raw
      .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2
        && typeof p[0] === 'number' && typeof p[1] === 'number')
      .map(p => [p[0], p[1]])
  }
  if (typeof raw === 'string') {
    try {
      return parseTrailGeometry(JSON.parse(raw))
    }
    catch {
      return []
    }
  }
  return []
}

export function routesFromTrails(trails: UiTrail[], geometryById: Record<number, LatLng[]>): Record<number, LatLng[]> {
  const routes: Record<number, LatLng[]> = {}
  for (const t of trails) {
    const geom = geometryById[t.id]
    if (geom && geom.length >= 2)
      routes[t.id] = geom
    // Missing geometry stays missing. A fabricated diagonal line looks like a
    // navigable route and is materially more dangerous than an honest
    // "route unavailable" state.
  }
  return routes
}

export function normalizeTrailRow(row: Record<string, unknown>): UiTrail | null {
  const id = Number(row.id)
  if (!Number.isFinite(id))
    return null

  const lat = Number(row.latitude ?? row.lat)
  const lng = Number(row.longitude ?? row.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng))
    return null

  // Distance and elevation pass through unconverted. The national ingest
  // normalizes to miles and feet at write time (see app/Ingest/types.ts), so
  // the column IS the display unit. This used to call kmToMi/metersToFt on the
  // way in, which quietly reported every 8.4-mile trail as 5.2 miles once the
  // ingest started writing miles.
  const distanceMiles = Number(row.distance) || 0
  const elevationFeet = Number(row.elevation) || 0
  const tagsRaw = row.tags
  const tags = typeof tagsRaw === 'string'
    ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean)
    : Array.isArray(tagsRaw) ? tagsRaw.map(String) : []

  const difficulty = row.difficulty
  const diff = difficulty === 'easy' || difficulty === 'moderate' || difficulty === 'hard'
    ? difficulty
    : 'moderate'

  return {
    id,
    name: String(row.name ?? 'Unnamed trail'),
    location: String(row.location ?? ''),
    difficulty: diff,
    distance: Math.round(distanceMiles * 10) / 10,
    elevation: Math.round(elevationFeet),
    // Re-formatted rather than passed through: rows ingested before the day
    // scale existed hold `388h 18m`, which is the same duration written in a
    // unit nobody reads.
    estimatedTime: displayTrailTime(String(row.estimatedTime ?? row.estimated_time ?? '')),
    rating: Number(row.rating) || 0,
    reviewCount: Number(row.reviewCount ?? row.review_count) || 0,
    description: String(row.description ?? ''),
    lat,
    lng,
    image: row.image ? String(row.image) : null,
    tags,
    conditions: String(row.conditions ?? 'Conditions reported by the community.'),
    state: String(row.state ?? ''),
    managedBy: String(row.managedBy ?? row.managed_by ?? ''),
    routeType: normalizeRouteType(row.routeType ?? row.route_type),
    surface: String(row.surface ?? ''),
    source: String(row.source ?? ''),
    sourceUrl: String(row.sourceUrl ?? row.source_url ?? ''),
    nationalTrail: Boolean(row.nationalTrail ?? row.national_trail),
  }
}

function normalizeRouteType(raw: unknown): UiTrail['routeType'] {
  return raw === 'loop' || raw === 'out-and-back' || raw === 'point-to-point' || raw === 'network'
    ? raw
    : ''
}

export function extractApiTrailRows(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload))
    return payload as Record<string, unknown>[]
  if (payload && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    if (Array.isArray(obj.data))
      return obj.data as Record<string, unknown>[]
    if (Array.isArray(obj.trails))
      return obj.trails as Record<string, unknown>[]
  }
  return []
}

export function normalizeTrailsPayload(payload: unknown): {
  trails: UiTrail[]
  geometryById: Record<number, LatLng[]>
} {
  const trails: UiTrail[] = []
  const geometryById: Record<number, LatLng[]> = {}

  for (const row of extractApiTrailRows(payload)) {
    const trail = normalizeTrailRow(row)
    if (!trail)
      continue
    trails.push(trail)
    const geom = parseTrailGeometry(row.geometry)
    if (geom.length >= 2)
      geometryById[trail.id] = geom
  }

  return { trails, geometryById }
}

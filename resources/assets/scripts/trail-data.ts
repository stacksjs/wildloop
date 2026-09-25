/**
 * Trail API ↔ UI normalization (Stacks ORM uses camelCase in JSON).
 */

import { decodeRouteParts, primaryRoutePart } from '../../functions/trail-geometry'
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
  /** Uploader of a community cover, when one replaces an illustrative photo. */
  coverCredit: string
  coverSourceUrl: string
  coverLicense: string
  coverLicenseUrl: string
  /** An area image must not be presented as a photo of this exact trail. */
  coverScope: 'area' | ''
  coverPlace: string
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
  /**
   * Suitability, as the managing agency reports it. `null` is not `false`:
   * "we do not know whether dogs are allowed" and "dogs are banned" are
   * different answers, and only one of them is ours to put on the page.
   */
  dogsAllowed: boolean | null
  wheelchairAccessible: boolean | null
}

/**
 * A trail's main line from stored geometry (`[[lat,lng],…]`, or one array per
 * part when the trail is in several pieces — see functions/trail-geometry).
 *
 * This is the line navigation, records, offline download and thumbnails
 * follow: the only part, or the longest. Parts are never glued end to end —
 * that glue is a straight line across whatever lies between them.
 */
export function parseTrailGeometry(raw: unknown): LatLng[] {
  return primaryRoutePart(raw)
}

/** Every part of a trail's stored geometry, for drawing the whole trail. */
export function parseTrailGeometryParts(raw: unknown): LatLng[][] {
  return decodeRouteParts(raw)
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
    coverCredit: String(row.coverCredit ?? row.cover_credit ?? '').trim(),
    coverSourceUrl: String(row.coverSourceUrl ?? row.cover_source_url ?? '').trim(),
    coverLicense: String(row.coverLicense ?? row.cover_license ?? '').trim(),
    coverLicenseUrl: String(row.coverLicenseUrl ?? row.cover_license_url ?? '').trim(),
    coverScope: (row.coverScope ?? row.cover_scope) === 'area' ? 'area' : '',
    coverPlace: String(row.coverPlace ?? row.cover_place ?? '').trim(),
    tags,
    conditions: String(row.conditions ?? ''),
    state: String(row.state ?? ''),
    managedBy: String(row.managedBy ?? row.managed_by ?? ''),
    routeType: normalizeRouteType(row.routeType ?? row.route_type),
    surface: String(row.surface ?? ''),
    source: String(row.source ?? ''),
    sourceUrl: String(row.sourceUrl ?? row.source_url ?? ''),
    nationalTrail: Boolean(row.nationalTrail ?? row.national_trail),
    dogsAllowed: readTriState(row.dogsAllowed ?? row.dogs_allowed),
    wheelchairAccessible: readTriState(row.wheelchairAccessible ?? row.wheelchair_accessible),
  }
}

/** true / false / unknown, from a column that may be absent, 0/1 or a string. */
function readTriState(raw: unknown): boolean | null {
  if (raw === null || raw === undefined || raw === '')
    return null
  if (typeof raw === 'boolean')
    return raw
  if (typeof raw === 'number')
    return raw !== 0
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase()
    if (value === 'true' || value === '1' || value === 'yes')
      return true
    if (value === 'false' || value === '0' || value === 'no')
      return false
  }
  return null
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
  /** Each trail's main line. */
  geometryById: Record<number, LatLng[]>
  /** Every part, only for the trails that are in more than one piece. */
  routePartsById: Record<number, LatLng[][]>
} {
  const trails: UiTrail[] = []
  const geometryById: Record<number, LatLng[]> = {}
  const routePartsById: Record<number, LatLng[][]> = {}

  for (const row of extractApiTrailRows(payload)) {
    const trail = normalizeTrailRow(row)
    if (!trail)
      continue
    trails.push(trail)
    const parts = parseTrailGeometryParts(row.geometry)
    const geom = parts.length > 1 ? parseTrailGeometry(parts) : parts[0] ?? []
    if (geom.length >= 2)
      geometryById[trail.id] = geom
    if (parts.length > 1)
      routePartsById[trail.id] = parts
  }

  return { trails, geometryById, routePartsById }
}

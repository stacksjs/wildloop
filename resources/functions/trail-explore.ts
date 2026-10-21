/**
 * The map of trails around you (the Explore screen, `/explore`).
 *
 * What it asks the trails API, and where it puts the camera, as plain
 * functions: a native screen runs in a bare JavaScript context, so nothing
 * here touches a web API (see CLAUDE.md).
 */

import type { UiTrail } from '../assets/scripts/trail-data'

/** A visible map, as the map's `region-change-complete` event reports it. */
export interface ExploreRegion {
  center: { latitude: number, longitude: number }
  span: { latitudeDelta: number, longitudeDelta: number }
}

const MILES_PER_DEGREE = 69
/** The API's floor and ceiling for a "near me" radius, in miles. */
export const EXPLORE_MIN_RADIUS = 5
export const EXPLORE_MAX_RADIUS = 300
/** How many trails the map draws at once: enough to browse, few enough to read. */
export const EXPLORE_LIMIT = 80

/** The miles from the centre of the visible map to its farthest edge, as a search radius. */
export function exploreRadius(region: ExploreRegion): number {
  const latitude = region.center.latitude
  const north = Math.abs(region.span.latitudeDelta) / 2 * MILES_PER_DEGREE
  const east = Math.abs(region.span.longitudeDelta) / 2 * MILES_PER_DEGREE * Math.cos(latitude * Math.PI / 180)
  const radius = Math.ceil(Math.max(north, east))
  if (!Number.isFinite(radius)) return EXPLORE_MIN_RADIUS
  return Math.min(EXPLORE_MAX_RADIUS, Math.max(EXPLORE_MIN_RADIUS, radius))
}

/** A camera this far from where the last search ran makes "Search this area" worth offering. */
export function exploreMovedFar(searched: ExploreRegion | null, now: ExploreRegion): boolean {
  if (!searched) return true
  const moved = Math.max(
    Math.abs(now.center.latitude - searched.center.latitude) / Math.max(searched.span.latitudeDelta, 1e-6),
    Math.abs(now.center.longitude - searched.center.longitude) / Math.max(searched.span.longitudeDelta, 1e-6),
  )
  const zoomed = Math.abs(Math.log2(Math.max(now.span.latitudeDelta, 1e-6) / Math.max(searched.span.latitudeDelta, 1e-6)))
  return moved > 0.25 || zoomed > 0.75
}

/** A trail the map can pin: one with a trailhead. */
export interface ExploreMarker {
  id: number
  title: string
  geometry: [number, number]
}

export function exploreMarkers(trails: readonly Partial<UiTrail>[]): ExploreMarker[] {
  const markers: ExploreMarker[] = []
  for (const trail of trails) {
    const lat = Number(trail.lat)
    const lng = Number(trail.lng)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0) || !trail.id) continue
    markers.push({ id: Number(trail.id), title: String(trail.name ?? 'Trail'), geometry: [lat, lng] })
  }
  return markers
}

/** The camera that shows every pinned trail, with a margin; `null` when there is nothing to show. */
export function exploreRegionFor(markers: readonly ExploreMarker[], around?: { lat: number, lng: number } | null): ExploreRegion | null {
  const points = markers.map(marker => marker.geometry)
  if (around) points.push([around.lat, around.lng])
  if (!points.length) return null
  let south = Infinity
  let north = -Infinity
  let west = Infinity
  let east = -Infinity
  for (const [lat, lng] of points) {
    south = Math.min(south, lat)
    north = Math.max(north, lat)
    west = Math.min(west, lng)
    east = Math.max(east, lng)
  }
  // A lone trail, or a search that found one: a few miles around it, not a
  // span of zero the map would zoom into the ground.
  const minimum = 0.08
  return {
    center: { latitude: (south + north) / 2, longitude: (west + east) / 2 },
    span: { latitudeDelta: Math.max(minimum, (north - south) * 1.3), longitudeDelta: Math.max(minimum, (east - west) * 1.3) },
  }
}

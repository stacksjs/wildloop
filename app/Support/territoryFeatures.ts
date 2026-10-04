import { parseBoundingBox } from '../../resources/functions/geo'
import { avatarOf } from './avatars'

/**
 * A territory as the game map draws it: a GeoJSON feature.
 *
 * Shared by the map and by a single territory's page, because the privacy
 * rule lives here and must not differ between them: an outline is coarse
 * (its bounding box) unless the viewer owns it or its owner opted into
 * precise outlines.
 */
export function territoryFeature(territory: any, context: {
  viewerId: number | null
  owner: any
  ownerSettings: any
  defendCount: number
}) {
  const isOwned = context.viewerId ? territory.user_id === context.viewerId : false

  let geometry: any
  try {
    geometry = JSON.parse(territory.polygon_data)
  }
  catch {
    geometry = null
  }
  const canSeePrecise = Boolean(isOwned || context.ownerSettings?.show_precise_territories)
  if (geometry && !canSeePrecise && territory.bounding_box) {
    const bbox = parseBoundingBox(territory.bounding_box)
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
    type: 'Feature' as const,
    properties: {
      id: territory.id,
      name: territory.name,
      ownerId: territory.user_id,
      ownerName: context.owner?.name || 'Unknown',
      ownerAvatar: avatarOf(context.owner),
      isOwned,
      areaSize: territory.area_size,
      perimeter: territory.perimeter,
      conquestCount: territory.conquest_count,
      defendCount: context.defendCount,
      claimedAt: territory.claimed_at,
      status: territory.status,
      centerLat: territory.center_lat,
      centerLng: territory.center_lng,
      preciseGeometry: canSeePrecise,
    },
    geometry,
  }
}

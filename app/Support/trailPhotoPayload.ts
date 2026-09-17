/**
 * What the API says about a trail photo. No database, so it can be tested.
 *
 * Photos are addressed by UUID, never by row id, so the URLs do not reveal how
 * many photos exist or let anyone walk through them in order.
 */

export interface TrailPhotoRow {
  uuid: string
  trail_id: number
  user_id: number
  width: number
  height: number
  created_at: string
  user_name?: string | null
}

export interface TrailPhotoPayload {
  id: string
  trailId: number
  url: string
  thumbUrl: string
  width: number
  height: number
  credit: string
  createdAt: string
  mine: boolean
}

/** The app URL a stored photo is served from. The bucket itself is private. */
export function trailPhotoUrl(trailId: number, uuid: string, size: 'display' | 'thumb' = 'display'): string {
  return `/api/trail-photos/${trailId}/${uuid}${size === 'thumb' ? '-thumb' : ''}.jpg`
}

export function toTrailPhotoPayload(row: TrailPhotoRow, viewerId: number | null): TrailPhotoPayload {
  return {
    id: row.uuid,
    trailId: Number(row.trail_id),
    url: trailPhotoUrl(Number(row.trail_id), row.uuid),
    thumbUrl: trailPhotoUrl(Number(row.trail_id), row.uuid, 'thumb'),
    width: Number(row.width),
    height: Number(row.height),
    credit: String(row.user_name ?? '').trim(),
    createdAt: row.created_at,
    mine: viewerId !== null && Number(row.user_id) === Number(viewerId),
  }
}

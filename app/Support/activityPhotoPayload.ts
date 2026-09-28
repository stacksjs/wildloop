/**
 * What the API says about a photo on an activity. No database, so it can be
 * tested.
 *
 * Addressed by UUID rather than row id, like trail photos, so a URL says
 * nothing about how many photos exist and cannot be walked through in order.
 *
 * There is no `credit` here, and that is the difference from a trail photo
 * rather than an omission: every photo on an activity was taken by the athlete
 * whose activity it is, and the page already says whose run it is. Repeating
 * the name under each picture would be noise.
 */

export interface ActivityPhotoRow {
  uuid: string
  activity_id: number
  user_id: number
  width: number
  height: number
  position?: number | null
  created_at: string
}

export interface ActivityPhotoPayload {
  id: string
  activityId: number
  url: string
  thumbUrl: string
  width: number
  height: number
  createdAt: string
  mine: boolean
}

/** The app URL a stored photo is served from. The bucket itself is private. */
export function activityPhotoUrl(activityId: number, uuid: string, size: 'display' | 'thumb' = 'display'): string {
  return `/api/activity-photos/${activityId}/${uuid}${size === 'thumb' ? '-thumb' : ''}.jpg`
}

export function toActivityPhotoPayload(row: ActivityPhotoRow, viewerId: number | null): ActivityPhotoPayload {
  return {
    id: row.uuid,
    activityId: Number(row.activity_id),
    url: activityPhotoUrl(Number(row.activity_id), row.uuid),
    thumbUrl: activityPhotoUrl(Number(row.activity_id), row.uuid, 'thumb'),
    width: Number(row.width),
    height: Number(row.height),
    createdAt: row.created_at,
    mine: viewerId !== null && Number(row.user_id) === Number(viewerId),
  }
}

import type { SqlTag } from './trailViews'
import { db } from '@stacksjs/orm'
import { isStockTrailPhoto } from '../../resources/functions/stock-photos'
import { licenseLink } from './photoLicenses'

/**
 * Commons photographs a person approved on /admin/photos, as trail covers.
 *
 * The same promise as `curatedTrailPhotos.ts`, kept in a table instead of in
 * code: somebody looked at the file page and the picture and said this is
 * the trail. Applied on read rather than written into `trails.image`, for the
 * same reason the curated seed is — the credit and licence have to travel
 * with the picture, and the catalog row has nowhere to keep them.
 *
 * It fills only an empty or illustrative cover. An image an editor chose, a
 * community upload, or a curated photo applied before this one all stay put.
 */

export interface ApprovedTrailPhoto {
  trail_id: number
  url: string
  page_url: string
  credit: string
  license: string
  license_url: string
}

interface ApprovedCoverTrail {
  id: number
  image?: string | null
  [key: string]: unknown
}

/** Put one approved photograph on a trail, with the attribution the trail page and cards render. */
export function applyApprovedTrailPhoto<T extends ApprovedCoverTrail>(trail: T, photo: ApprovedTrailPhoto | undefined): T {
  if (!photo || !photo.url)
    return trail
  if (trail.image && !isStockTrailPhoto(trail.image))
    return trail

  return {
    ...trail,
    image: photo.url,
    coverCredit: photo.credit,
    coverSourceUrl: photo.page_url,
    coverLicense: photo.license,
    coverLicenseUrl: licenseLink(photo.license_url, photo.page_url),
  }
}

const ormSql: SqlTag = async (strings, ...values) => ((await db.sql(strings, ...values).execute()) as any[]) ?? []

/**
 * The approved photograph for each of a page of trails, in one read.
 *
 * The ids go in as one bound JSON array rather than a spliced IN list, so
 * nothing about them reaches the SQL text. The most recently approved wins if
 * a trail somehow has two. A missing table - a database the migration has not
 * reached yet - costs the covers, not the page.
 */
export async function approvedTrailPhotos(trailIds: number[], sql: SqlTag = ormSql): Promise<Map<number, ApprovedTrailPhoto>> {
  const ids = [...new Set(trailIds.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))]
  const found = new Map<number, ApprovedTrailPhoto>()
  if (ids.length === 0)
    return found

  const rows = await sql`
    SELECT trail_id, url, page_url, credit, license, license_url
    FROM trail_photo_candidates
    WHERE status = 'approved' AND trail_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
    ORDER BY reviewed_at ASC, id ASC
  `.catch(() => []) as ApprovedTrailPhoto[]

  // Ascending, so the last write for a trail is the newest approval.
  for (const row of rows ?? [])
    found.set(Number(row.trail_id), { ...row, trail_id: Number(row.trail_id) })
  return found
}

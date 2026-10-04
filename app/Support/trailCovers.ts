import { db } from '@stacksjs/orm'
import { isStockTrailPhoto } from '../../resources/functions/stock-photos'
import { applyApprovedTrailPhoto, approvedTrailPhotos } from './approvedTrailPhotos'
import { applyCuratedTrailPhoto } from './curatedTrailPhotos'
import { applyTrailAreaPhoto } from './trailAreaPhotos'
import { trailPhotoUrl } from './trailPhotoPayload'

export interface CoverTrail {
  id: number
  image?: string | null
  [key: string]: unknown
}

export interface CommunityCover {
  trail_id: number
  uuid: string
  user_name?: string | null
}

/** Only stock or empty covers may be replaced. A curated image stays put. */
export function trailsNeedingCommunityCover(trails: CoverTrail[]): number[] {
  return trails
    .filter(trail => !trail.image || isStockTrailPhoto(trail.image))
    .map(trail => Number(trail.id))
    .filter(id => Number.isSafeInteger(id) && id > 0)
}

/** A visible, trail-specific upload beats an illustrative catalog cover. */
export function applyCommunityCovers(trails: CoverTrail[], covers: CommunityCover[], size: 'thumb' | 'display' = 'thumb'): CoverTrail[] {
  const byTrail = new Map(covers.map(cover => [Number(cover.trail_id), cover]))

  return trails.map((trail) => {
    if (trail.image && !isStockTrailPhoto(trail.image))
      return trail

    const cover = byTrail.get(Number(trail.id))
    if (!cover)
      return trail

    return {
      ...trail,
      image: trailPhotoUrl(Number(trail.id), cover.uuid, size),
      coverCredit: String(cover.user_name ?? '').trim(),
    }
  })
}

/** Fetch only one visible upload per trail in a single, page-bounded query. */
export async function latestVisibleCommunityCovers(ids: number[]): Promise<CommunityCover[]> {
  if (!ids.length)
    return []

  // All ids come from the validated numeric primary keys above, so this IN
  // list cannot contain user input or arbitrary SQL.
  return await db.sql`
    SELECT trail_id, uuid, user_name FROM (
      SELECT p.trail_id, p.uuid, u.name AS user_name,
        ROW_NUMBER() OVER (PARTITION BY p.trail_id ORDER BY p.created_at DESC, p.id DESC) AS rank
      FROM trail_photos p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.status = 'visible' AND p.trail_id IN (${db.unsafe(ids.join(', '))})
    ) WHERE rank = 1
  `.execute() as CommunityCover[]
}

/**
 * Community photos win, then the small reviewed seed, then a Commons photo a
 * person approved on /admin/photos (approvedTrailPhotos.ts), then a photo of
 * the area, then stock art. Both reads are one query for the whole page.
 */
export async function withBestTrailCovers<T extends CoverTrail>(trails: T[], size: 'thumb' | 'display' = 'thumb'): Promise<T[]> {
  const ids = trailsNeedingCommunityCover(trails)
  const [covers, approved] = await Promise.all([latestVisibleCommunityCovers(ids), approvedTrailPhotos(ids)])
  return applyCommunityCovers(trails, covers, size)
    .map(trail => applyTrailAreaPhoto(applyApprovedTrailPhoto(applyCuratedTrailPhoto(trail as T), approved.get(Number(trail.id))))) as T[]
}

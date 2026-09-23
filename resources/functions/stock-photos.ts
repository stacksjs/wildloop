/**
 * The licensed landscape photographs the catalog uses as a trail's cover when
 * its source publishes no photo. That is nearly every trail: neither the Forest
 * Service nor the Park Service publishes photos in the layers Wildloop ingests,
 * and OSM almost never does.
 *
 * They are illustrations, not pictures of the trail they appear on, so anything
 * that shows one as a trail's photo has to be able to say so. The ingest picks
 * from this list and the pages check against it, which keeps the two in step.
 */
export const STOCK_TRAIL_PHOTOS = [
  'https://images.unsplash.com/photo-1551632811-561732d1e306?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1454391304352-2bf4678b1a7a?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1465056836041-7f43ac27dcb5?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1476231682828-37e571bc172f?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1519681393784-d120267933ba?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1533240332313-0db49b459ad6?w=800&h=600&fit=crop',
  'https://images.unsplash.com/photo-1500534314209-a25ddb2bd429?w=800&h=600&fit=crop',
] as const

/** The photo's identity: its path, without the sizing query a view may add. */
function stockPhotoKey(url: string): string | null {
  try {
    const parsed = new URL(url)
    return parsed.hostname === 'images.unsplash.com' ? parsed.pathname : null
  }
  catch {
    return null
  }
}

const STOCK_KEYS = new Set(STOCK_TRAIL_PHOTOS.map(url => stockPhotoKey(url)))

/** Whether this URL is one of the stock covers, at any size. */
export function isStockTrailPhoto(url: string | null | undefined): boolean {
  if (!url)
    return false
  const key = stockPhotoKey(String(url).trim())
  return key !== null && STOCK_KEYS.has(key)
}

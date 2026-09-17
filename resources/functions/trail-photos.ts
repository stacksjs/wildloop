/**
 * The photos a trail page can show.
 *
 * A catalog row carries one image — the same one on the card and at the top of
 * the page — while the pictures that say what a trail is actually like come
 * from the people who walked it and attached them to a review. This turns both
 * into one gallery, with the credit kept next to each frame.
 *
 * Parsing is defensive on purpose: `photos` is a free-text column that has held
 * JSON arrays, comma-separated lists and single URLs, and anything that is not
 * plainly an image URL is dropped rather than rendered into a `src`.
 */

import { isStockTrailPhoto } from './stock-photos'

export interface GalleryPhoto {
  url: string
  /** Who took it, when that is known. Empty for the catalog's own image. */
  credit: string
  /** A stock cover, not a picture of this trail. */
  illustrative: boolean
}

/** Where a photo may come from: absolute http(s), or this site's own root. */
function isRenderableUrl(value: string): boolean {
  const url = value.trim()
  if (!url)
    return false
  if (url.startsWith('/') && !url.startsWith('//'))
    return true
  return /^https:\/\/[^\s"'<>]+$/i.test(url) || /^http:\/\/[^\s"'<>]+$/i.test(url)
}

/**
 * Read a stored `photos` value into a list of URLs. Accepts a JSON array, a
 * comma-separated string, a single URL, or an already-parsed array.
 */
export function parsePhotoList(raw: unknown): string[] {
  if (!raw)
    return []

  if (Array.isArray(raw))
    return raw.map(String).map(value => value.trim()).filter(isRenderableUrl)

  if (typeof raw !== 'string')
    return []

  const text = raw.trim()
  if (!text)
    return []

  if (text.startsWith('[')) {
    try {
      return parsePhotoList(JSON.parse(text))
    }
    catch {
      // A malformed array is not a URL either. Fall through to the split
      // below, which recovers the common case of a trailing comma.
    }
  }

  return text.split(',').map(value => value.trim()).filter(isRenderableUrl)
}

export interface GalleryTrail {
  image?: string | null
  name?: string | null
}

export interface GalleryReview {
  photos?: unknown
  userName?: string | null
}

/** The most frames worth loading behind one trail. */
const MAX_PHOTOS = 12

/**
 * The gallery for a trail: its own picture first, then whatever the reviews
 * brought, deduplicated and capped.
 *
 * The catalog image leads because it is the one chosen to represent the trail;
 * review photos follow in the order they were given, which is newest first
 * wherever the caller passes them that way.
 */
export function trailGallery(trail: GalleryTrail | null, reviews: GalleryReview[] = []): GalleryPhoto[] {
  const photos: GalleryPhoto[] = []
  const seen = new Set<string>()

  const push = (url: string, credit: string) => {
    const clean = url.trim()
    if (!isRenderableUrl(clean) || seen.has(clean) || photos.length >= MAX_PHOTOS)
      return
    seen.add(clean)
    photos.push({ url: clean, credit, illustrative: isStockTrailPhoto(clean) })
  }

  if (trail?.image)
    push(String(trail.image), '')

  for (const review of reviews) {
    const credit = String(review?.userName ?? '').trim()
    for (const url of parsePhotoList(review?.photos))
      push(url, credit)
  }

  return photos
}

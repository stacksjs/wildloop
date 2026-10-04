import { simplifyTrack } from '../../resources/functions/geo'
import { decodeRouteParts, encodeRouteParts } from '../../resources/functions/trail-geometry'

/**
 * Degrees of tolerance for a trail's line in a list: about three metres.
 *
 * Measured on 2,000 trails around Los Angeles, this keeps half the points and
 * 54% of the gzipped bytes, and no point moves more than three metres off the
 * stored line — less than a phone's own GPS error. That matters because the
 * line a list delivers is not only drawn on a card: the store keeps it, and a
 * trail page opened from the list, a run recorded against the trail and an
 * offline download all use it without fetching the trail again. Anything
 * coarser would have to be fetched again for all of those; this does not.
 */
export const LIST_TOLERANCE_DEGREES = 0.00003

/**
 * A trail's stored geometry, thinned for a list response, in the same format
 * it is stored in: one part or several, `[[lat, lng], …]`.
 *
 * Douglas-Peucker per part, so a straight stretch loses its intermediate
 * points and a switchback keeps every turn. Parts stay parts. Geometry that
 * cannot be read is passed through untouched rather than dropped.
 */
export function listGeometry(raw: unknown, tolerance = LIST_TOLERANCE_DEGREES): unknown {
  if (raw === null || raw === undefined || raw === '')
    return raw
  const parts = decodeRouteParts(raw)
  if (parts.length === 0)
    return raw
  const thinned = parts.map(part => simplifyTrack(part.map(([lat, lng]) => ({ lat, lng })), tolerance))
  return encodeRouteParts(thinned)
}

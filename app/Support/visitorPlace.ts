/**
 * A place name a person would recognise.
 *
 * The CDN reports a subdivision as an ISO code, and only some countries use
 * letters for it. The Philippines uses numbers, so Lapu-Lapu City came back
 * labelled "Lapu-Lapu City, 07" — which reads as a bug in the page rather than
 * as a region. A numeric code says nothing to anybody, so the country is
 * better company for the city than its own subdivision number.
 */
export function visitorLabel(
  city?: string | null,
  region?: string | null,
  country?: string | null,
): string | null {
  const place = (city ?? '').trim()
  const subdivision = (region ?? '').trim()
  const nation = (country ?? '').trim()

  const named = subdivision && !/^\d+$/.test(subdivision) ? subdivision : ''
  const parts = [place, named || nation].filter(Boolean)

  return parts.length > 0 ? [...new Set(parts)].join(', ') : (nation || null)
}

/**
 * Which licences a photograph can carry and still go on a trail.
 *
 * Wildloop is a product with paid plans, so a cover has to be one a business
 * may reuse: credit the author, link the licence, and nothing else asked.
 * That is four families and no more —
 *
 * - CC BY, any version or port
 * - CC BY-SA, any version or port (the cover is shown, not adapted into a
 *   new work, and a crop for a card is the kind of change the credit line
 *   already says out loud)
 * - CC0
 * - the public domain, in whichever jurisdiction Commons names
 *
 * Everything else is refused, including licences that are free in other
 * senses. NonCommercial rules out a paid product outright, and NoDerivatives
 * rules out the crop every card makes. GFDL asks for its whole text to travel
 * with the picture. "Copyrighted free use", "No restrictions" and the rest
 * are statements about a file rather than licences, and the safe reading of
 * one is that somebody has to look. A licence that is not recognised is not
 * accepted, so a new spelling costs a candidate, never a takedown.
 */

export type LicenseFamily = 'cc-by' | 'cc-by-sa' | 'cc0' | 'public-domain'

/**
 * One shape rather than a union: the app is type-checked without strict null
 * checks, where a union on `allowed` does not narrow.
 */
export interface LicenseVerdict {
  allowed: boolean
  /** Set when allowed. */
  family: LicenseFamily | null
  /** Why not, when refused. Empty when allowed. */
  reason: string
}

const allow = (family: LicenseFamily): LicenseVerdict => ({ allowed: true, family, reason: '' })
const refuse = (reason: string): LicenseVerdict => ({ allowed: false, family: null, reason })

/** Upper case, every run of spaces, dashes and underscores as one space. */
function normalise(value: unknown): string {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[\s_-]+/g, ' ')
    .trim()
}

/** NonCommercial or NoDerivatives, in a short name or a licence URL. */
const NC = /\bNC\b|NON ?COMMERCIAL/
const ND = /\bND\b|NO ?DERIV/

/**
 * Whether a photograph under this licence may become a trail cover.
 *
 * `shortName` is Commons' `LicenseShortName` ("CC BY-SA 4.0", "Public
 * domain", "CC0"); `url` is its `LicenseUrl`, which is checked too, because a
 * short name is free text and the URL is the licence itself.
 */
export function licenseVerdict(shortName: unknown, url: unknown = ''): LicenseVerdict {
  const name = normalise(shortName)
  const link = normalise(url)

  if (!name)
    return refuse('no licence recorded')

  // Refusals first, so "CC BY-NC-SA" is never read as a kind of CC BY-SA.
  if (NC.test(name) || NC.test(link))
    return refuse(`non-commercial licence (${String(shortName).trim()})`)
  if (ND.test(name) || ND.test(link))
    return refuse(`no-derivatives licence (${String(shortName).trim()})`)

  if (/^CC ?0\b|^CC ZERO\b/.test(name) || /PUBLICDOMAIN\/ZERO/.test(link))
    return allow('cc0')

  // "Public domain", "PD", "PD-US", "PD-self", "PD USGov"... Commons names the
  // jurisdiction or the reason, never a condition.
  if (/^PUBLIC DOMAIN\b|^PD\b|^PDM\b/.test(name) || /PUBLICDOMAIN\/MARK/.test(link))
    return allow('public-domain')

  // "CC BY-SA 4.0", "CC-BY-SA-3.0-de", "CC BY-SA 3.0 migrated".
  if (/^CC BY SA(?: \d|$)|^CREATIVE COMMONS ATTRIBUTION SHARE ?ALIKE\b/.test(name))
    return allow('cc-by-sa')
  // "CC BY 2.0", "CC-BY-4.0", "CC BY 3.0 US" - a version straight after BY,
  // so "CC BY-XY" for some licence nobody has written yet is not waved through.
  if (/^CC BY(?: \d|$)|^CREATIVE COMMONS ATTRIBUTION(?: \d|$)/.test(name))
    return allow('cc-by')

  return refuse(`not a licence a cover can use (${String(shortName).trim()})`)
}

/** The page a licence's terms live on, or the file page when Commons gives none. */
export function licenseLink(licenseUrl: string | null | undefined, pageUrl: string | null | undefined): string {
  const link = String(licenseUrl ?? '').trim()
  if (/^https?:\/\//i.test(link))
    return link.replace(/^http:\/\//i, 'https://')
  return String(pageUrl ?? '').trim()
}

/**
 * What a trail *is*, said in a word.
 *
 * A catalog row carries its facts as loose tags plus a handful of booleans,
 * and a card has room for roughly one of them. This module turns that raw
 * material into the three things the UI actually renders:
 *
 *   - `trailFeatures` — every attribute worth a chip, labelled and iconed.
 *   - `trailHighlight` — the single one that earns the badge on a photo.
 *   - `trailNotices`   — the "Information" row: what somebody should know
 *                        before driving out there.
 *
 * Nothing here invents a fact. A tag the catalog does not carry produces no
 * chip, and a notice only exists because a column says so — a trail card that
 * promises a waterfall the data never mentioned is worse than a plain one.
 */

/** A chip: one attribute of a trail, ready to render. */
export interface TrailFeature {
  /** Normalized tag key, stable enough to use as a list key or filter value. */
  key: string
  label: string
  /** Iconify class. Empty for a tag we have no icon for — the label stands alone. */
  icon: string
}

/** A line in the trail's "Information" list. */
export interface TrailNotice {
  key: string
  /** `warn` gets amber and leads the list; `info` is neutral. */
  tone: 'warn' | 'info'
  title: string
  detail: string
  icon: string
}

export interface FeatureTrail {
  tags?: string[] | string | null
  dogsAllowed?: boolean | null
  wheelchairAccessible?: boolean | null
  nationalTrail?: boolean | null
  routeType?: string | null
  surface?: string | null
  distance?: number | null
  elevation?: number | null
}

/**
 * The tags we recognise, in the order a badge would be chosen.
 *
 * Ordering is editorial and deliberate: "kid-friendly" changes whether a
 * family goes at all, while "forest" is true of most of the catalog. The first
 * match down this list is what a card shows.
 */
const KNOWN_TAGS: Array<{ key: string, label: string, icon: string, aliases: string[] }> = [
  { key: 'kid-friendly', label: 'Kid-friendly', icon: 'i-lucide-baby', aliases: ['kids', 'family', 'family-friendly', 'stroller'] },
  { key: 'dog-friendly', label: 'Dog-friendly', icon: 'i-lucide-dog', aliases: ['dogs', 'dogs-allowed', 'dog'] },
  { key: 'wildflowers', label: 'Wildflowers', icon: 'i-lucide-flower-2', aliases: ['flowers', 'wildflower', 'meadow'] },
  { key: 'waterfall', label: 'Waterfall', icon: 'i-lucide-droplets', aliases: ['waterfalls', 'falls', 'cascade'] },
  { key: 'views', label: 'Great views', icon: 'i-lucide-mountain-snow', aliases: ['scenic', 'vista', 'viewpoint', 'overlook', 'panorama'] },
  { key: 'summit', label: 'Summit', icon: 'i-lucide-triangle', aliases: ['peak', 'mountain', 'ridge'] },
  { key: 'lake', label: 'Lake', icon: 'i-lucide-waves', aliases: ['lakes', 'pond', 'reservoir', 'tarn'] },
  { key: 'river', label: 'River', icon: 'i-lucide-waves', aliases: ['creek', 'stream', 'brook'] },
  { key: 'beach', label: 'Coastal', icon: 'i-lucide-sailboat', aliases: ['coast', 'coastal', 'ocean', 'shore'] },
  { key: 'wildlife', label: 'Wildlife', icon: 'i-lucide-bird', aliases: ['birding', 'birdwatching', 'animals'] },
  { key: 'forest', label: 'Forest', icon: 'i-lucide-trees', aliases: ['woods', 'woodland', 'old-growth'] },
  { key: 'camping', label: 'Camping', icon: 'i-lucide-tent', aliases: ['backpacking', 'campsite', 'hut'] },
  { key: 'historic', label: 'Historic', icon: 'i-lucide-landmark', aliases: ['history', 'ruins', 'heritage', 'monument'] },
  { key: 'cave', label: 'Cave', icon: 'i-lucide-mountain', aliases: ['caves', 'grotto'] },
  { key: 'hot-springs', label: 'Hot springs', icon: 'i-lucide-thermometer-sun', aliases: ['hot-spring', 'springs'] },
  { key: 'swimming', label: 'Swimming', icon: 'i-lucide-waves', aliases: ['swim', 'swimming-hole'] },
  { key: 'fishing', label: 'Fishing', icon: 'i-lucide-fish', aliases: ['angling'] },
  { key: 'biking', label: 'Bike-friendly', icon: 'i-lucide-bike', aliases: ['bike', 'mtb', 'cycling', 'mountain-biking'] },
  { key: 'horseback', label: 'Horseback', icon: 'i-lucide-rabbit', aliases: ['horse', 'equestrian'] },
  { key: 'snow', label: 'Snowshoeing', icon: 'i-lucide-snowflake', aliases: ['snowshoe', 'snowshoeing', 'winter', 'skiing'] },
  { key: 'paved', label: 'Paved', icon: 'i-lucide-route', aliases: ['partially-paved', 'asphalt'] },
  { key: 'running', label: 'Trail running', icon: 'i-lucide-footprints', aliases: ['trail-running', 'run'] },
  { key: 'no-shade', label: 'Little shade', icon: 'i-lucide-sun', aliases: ['exposed', 'sun-exposed'] },
]

/** `Dog Friendly`, `dog_friendly` and `dog-friendly` are one tag. */
export function normalizeTagKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

/** Tags from either shape the API has used: an array, or a comma string. */
export function readTags(trail: FeatureTrail): string[] {
  const raw = trail?.tags
  const list = typeof raw === 'string'
    ? raw.split(',')
    : Array.isArray(raw) ? raw.map(String) : []

  const seen = new Set<string>()
  const tags: string[] = []
  for (const entry of list) {
    const key = normalizeTagKey(entry)
    if (!key || seen.has(key))
      continue
    seen.add(key)
    tags.push(key)
  }
  return tags
}

function matchKnownTag(key: string): { key: string, label: string, icon: string } | null {
  for (const known of KNOWN_TAGS) {
    if (known.key === key || known.aliases.includes(key))
      return { key: known.key, label: known.label, icon: known.icon }
  }
  return null
}

/** Turn a raw tag into a chip, falling back to a title-cased label. */
export function featureFromTag(raw: string): TrailFeature | null {
  const key = normalizeTagKey(raw)
  if (!key)
    return null

  const known = matchKnownTag(key)
  if (known)
    return known

  return {
    key,
    label: key.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
    icon: '',
  }
}

/**
 * Every chip for a trail: its tags, plus the booleans the catalog stores
 * outside the tag string so they read the same way on screen.
 */
export function trailFeatures(trail: FeatureTrail): TrailFeature[] {
  const features: TrailFeature[] = []
  const seen = new Set<string>()

  const push = (feature: TrailFeature | null) => {
    if (!feature || seen.has(feature.key))
      return
    seen.add(feature.key)
    features.push(feature)
  }

  if (trail?.dogsAllowed === true)
    push({ key: 'dog-friendly', label: 'Dog-friendly', icon: 'i-lucide-dog' })
  if (trail?.wheelchairAccessible === true)
    push({ key: 'accessible', label: 'Wheelchair accessible', icon: 'i-lucide-accessibility' })
  if (trail?.nationalTrail === true)
    push({ key: 'national-trail', label: 'National Trail', icon: 'i-lucide-landmark' })

  for (const tag of readTags(trail))
    push(featureFromTag(tag))

  return features
}

/**
 * The one attribute a card puts on the photo.
 *
 * Tags win over the booleans: "Waterfall" is why somebody picks this trail
 * over the next one, while "National Trail" is a classification. Returns null
 * rather than something generic — an empty corner of a photograph beats a
 * badge reading "Trail".
 */
export function trailHighlight(trail: FeatureTrail): TrailFeature | null {
  const tags = new Set(readTags(trail))

  for (const known of KNOWN_TAGS) {
    if (tags.has(known.key) || known.aliases.some(alias => tags.has(alias)))
      return { key: known.key, label: known.label, icon: known.icon }
  }

  if (trail?.nationalTrail === true)
    return { key: 'national-trail', label: 'National Trail', icon: 'i-lucide-landmark' }
  if (trail?.dogsAllowed === true)
    return { key: 'dog-friendly', label: 'Dog-friendly', icon: 'i-lucide-dog' }
  if (trail?.wheelchairAccessible === true)
    return { key: 'accessible', label: 'Accessible', icon: 'i-lucide-accessibility' }

  return null
}

const ROUTE_TYPES: Record<string, { label: string, icon: string }> = {
  'loop': { label: 'Loop', icon: 'i-lucide-rotate-cw' },
  'out-and-back': { label: 'Out & back', icon: 'i-lucide-move-horizontal' },
  'point-to-point': { label: 'Point to point', icon: 'i-lucide-move-right' },
  'network': { label: 'Trail network', icon: 'i-lucide-share-2' },
}

/** `out-and-back` → `Out & back`. Empty string for an unclassified route. */
export function routeTypeLabel(routeType: string | null | undefined): string {
  return ROUTE_TYPES[String(routeType ?? '')]?.label ?? ''
}

export function routeTypeIcon(routeType: string | null | undefined): string {
  return ROUTE_TYPES[String(routeType ?? '')]?.icon ?? 'i-lucide-route'
}

/** Ascent past which a route is a climb rather than a walk with a hill in it. */
const STEEP_ASCENT_FEET = 3000

/** Miles past which a route stops being a day out for almost everybody. */
const MULTI_DAY_MILES = 30

/**
 * What to say in the "Information" row.
 *
 * Every line is derived from a column, never guessed: a missing `dogsAllowed`
 * produces no line at all, because "we do not know" and "dogs are banned" are
 * different answers and only one of them is ours to give.
 */
export function trailNotices(trail: FeatureTrail, options: { hasRoute?: boolean } = {}): TrailNotice[] {
  const notices: TrailNotice[] = []

  if (trail?.dogsAllowed === false) {
    notices.push({
      key: 'no-dogs',
      tone: 'warn',
      title: 'No dogs',
      detail: 'Dogs are not permitted on this trail.',
      icon: 'i-lucide-dog',
    })
  }

  if (options.hasRoute === false) {
    notices.push({
      key: 'no-route',
      tone: 'warn',
      title: 'Route line unavailable',
      detail: 'We hold the trailhead for this trail but not its line. Carry your own map.',
      icon: 'i-lucide-route-off',
    })
  }

  const miles = Number(trail?.distance) || 0
  if (miles >= MULTI_DAY_MILES) {
    notices.push({
      key: 'multi-day',
      tone: 'warn',
      title: 'Multi-day route',
      detail: `${Math.round(miles).toLocaleString()} miles end to end. Plan overnights, resupply and any permits before you start.`,
      icon: 'i-lucide-tent',
    })
  }

  const ascent = Number(trail?.elevation) || 0
  if (ascent >= STEEP_ASCENT_FEET) {
    notices.push({
      key: 'steep',
      tone: 'info',
      title: 'Sustained climbing',
      detail: `${Math.round(ascent).toLocaleString()} ft of ascent. Expect the estimate to stretch on the way up.`,
      icon: 'i-lucide-trending-up',
    })
  }

  if (trail?.routeType === 'point-to-point') {
    notices.push({
      key: 'shuttle',
      tone: 'info',
      title: 'Finishes away from the start',
      detail: 'Point-to-point route — arrange a shuttle or a second car.',
      icon: 'i-lucide-move-right',
    })
  }

  if (trail?.wheelchairAccessible === true) {
    notices.push({
      key: 'accessible',
      tone: 'info',
      title: 'Wheelchair accessible',
      detail: 'The managing agency reports this route as wheelchair accessible.',
      icon: 'i-lucide-accessibility',
    })
  }

  return notices
}

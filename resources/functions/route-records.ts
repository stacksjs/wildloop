/**
 * Route records — Wildloop's fastest-known-time layer.
 *
 * The rest of the app ranks people by *volume*: miles run this week, feet
 * climbed, territory held. A record is the opposite question — who covered
 * *this exact route* fastest — and it needs its own vocabulary, because a
 * time is only comparable to another time run under the same rules.
 *
 * Three things make two times comparable, and all three are part of the key a
 * record is filed under:
 *
 *   - **Style.** What outside help was allowed. Carrying everything you need
 *     is a different sport from having a crew hand you a bottle every 10 miles.
 *   - **Direction.** A point-to-point run north-to-south is not the same
 *     effort as south-to-north, and a yo-yo is both plus the return.
 *   - **Category.** Self-identified, and solo is ranked apart from a team,
 *     because a team can share navigation, pacing, and load.
 *
 * Everything in this module is pure so that the submit form, the trail page,
 * and the server-side leaderboard all bucket and rank a time identically. A
 * client that disagrees with the server about which record stands is the one
 * bug a records board cannot survive.
 */

/**
 * Support styles, ordered from most to least assisted.
 *
 * The ordering matters beyond display: a time is only a headline record if it
 * beats every *more restrictive* style too. Being crewed to a 10-hour finish
 * on a route somebody has run unsupported in 9 is not the fastest anything.
 */
export const RECORD_STYLES = ['supported', 'self_supported', 'unsupported'] as const
export type RecordStyle = typeof RECORD_STYLES[number]

/** Self-identified, and never inferred from anything on the athlete's profile. */
export const RECORD_CATEGORIES = ['mens', 'womens', 'nonbinary'] as const
export type RecordCategory = typeof RECORD_CATEGORIES[number]

/**
 * Which way the route was travelled.
 *
 * `standard` covers loops and any route with only one sensible direction;
 * the distinction only earns its own board on point-to-point routes, where
 * the elevation profile reverses with the direction.
 */
export const RECORD_DIRECTIONS = ['standard', 'reverse', 'yo_yo'] as const
export type RecordDirection = typeof RECORD_DIRECTIONS[number]

/**
 * Lifecycle of one attempt.
 *
 * An attempt is a public object from the moment it starts, not from the
 * moment it succeeds: `in_progress` is what the tracking board reads, and
 * announcing a start before you know the outcome is what makes a live
 * tracker worth following.
 */
export const RECORD_STATUSES = ['in_progress', 'dnf', 'pending', 'verified', 'rejected'] as const
export type RecordStatus = typeof RECORD_STATUSES[number]

/** Statuses whose times are eligible to appear on a route's board. */
export const RANKED_STATUSES: readonly RecordStatus[] = ['verified', 'pending']

export const STYLE_LABELS: Record<RecordStyle, string> = {
  supported: 'Supported',
  self_supported: 'Self-supported',
  unsupported: 'Unsupported',
}

export const CATEGORY_LABELS: Record<RecordCategory, string> = {
  mens: "Men's",
  womens: "Women's",
  nonbinary: 'Non-binary',
}

export const DIRECTION_LABELS: Record<RecordDirection, string> = {
  standard: 'Standard',
  reverse: 'Reverse',
  yo_yo: 'Yo-yo',
}

export const STATUS_LABELS: Record<RecordStatus, string> = {
  in_progress: 'In progress',
  dnf: 'DNF',
  pending: 'Pending verification',
  verified: 'Verified',
  rejected: 'Not accepted',
}

/**
 * A route has to be worth racing before it is worth ranking.
 *
 * Below these thresholds a "record" is decided by which GPS watch rounded up,
 * not by who ran faster, and the board fills with driveway laps. The numbers
 * match the long-standing convention in the sport: 5 miles, or 500 feet of
 * gain for something short and steep.
 */
export const MIN_RECORD_DISTANCE_MI = 5
export const MIN_RECORD_ELEVATION_FT = 500

export interface RecordEligibility {
  eligible: boolean
  reason: string | null
}

/**
 * Whether a trail can carry a records board at all.
 *
 * Reported with a reason rather than a bare boolean so the submit form can
 * say *why* a route is not rankable instead of disabling a button silently.
 */
export function routeIsRankable(trail: { distance?: unknown, elevation?: unknown }): RecordEligibility {
  const distance = Number(trail?.distance ?? 0)
  const elevation = Number(trail?.elevation ?? 0)
  const longEnough = Number.isFinite(distance) && distance >= MIN_RECORD_DISTANCE_MI
  const steepEnough = Number.isFinite(elevation) && elevation >= MIN_RECORD_ELEVATION_FT
  if (longEnough || steepEnough)
    return { eligible: true, reason: null }
  return {
    eligible: false,
    reason: `Routes need at least ${MIN_RECORD_DISTANCE_MI} miles or ${MIN_RECORD_ELEVATION_FT} feet of gain to carry a records board.`,
  }
}

/**
 * Elapsed time, in seconds, between a start and a finish.
 *
 * Elapsed, never moving time: a record is measured by the clock on the wall
 * from the moment you leave the trailhead, so a two-hour nap counts. Returns
 * null rather than a negative or absurd number, which is what a mistyped date
 * produces and what would otherwise sort straight to the top of a board.
 */
export function elapsedSeconds(startedAt: string, finishedAt: string): number | null {
  const start = Date.parse(startedAt)
  const finish = Date.parse(finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(finish))
    return null
  const seconds = Math.round((finish - start) / 1000)
  // A minute is the floor for a real effort on a 5-mile route, and 100 days
  // is past any thru-run anyone has attempted; both ends are typos.
  if (seconds < 60 || seconds > 100 * 86_400)
    return null
  return seconds
}

/**
 * `2d 19h 26m` / `9h 04m` / `41m 12s`.
 *
 * Records run long, so `H:MM:SS` stops being readable somewhere around the
 * second sunrise. The unit that gets dropped is always the smallest one that
 * no longer changes the comparison.
 */
export function formatElapsed(seconds: number | null | undefined): string {
  const total = Number(seconds)
  if (!Number.isFinite(total) || total <= 0)
    return '—'
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = Math.floor(total % 60)
  if (days > 0)
    return `${days}d ${hours}h ${String(minutes).padStart(2, '0')}m`
  if (hours > 0)
    return `${hours}h ${String(minutes).padStart(2, '0')}m`
  return `${minutes}m ${String(secs).padStart(2, '0')}s`
}

/** Average pace over the whole elapsed clock, as `MM:SS/mi`. */
export function recordPace(distanceMi: number, seconds: number | null | undefined): string {
  const total = Number(seconds)
  if (!(distanceMi > 0) || !Number.isFinite(total) || total <= 0)
    return '—'
  const per = Math.round(total / distanceMi)
  return `${Math.floor(per / 60)}:${String(per % 60).padStart(2, '0')}/mi`
}

export interface RecordEffort {
  id: number
  userId: number
  userName?: string
  style: RecordStyle
  category: RecordCategory
  direction: RecordDirection
  teamSize: number
  status: RecordStatus
  elapsedSeconds: number | null
  startedAt: string
  finishedAt?: string | null
}

/**
 * The bucket a time competes in. Two efforts share a board iff this matches.
 *
 * Team size collapses to solo-or-team rather than being carried through
 * exactly: a pair and a trio share enough of the advantage that splitting
 * them produces boards with one entry each.
 */
export function recordBucketKey(effort: Pick<RecordEffort, 'style' | 'category' | 'direction' | 'teamSize'>): string {
  const team = Number(effort.teamSize) > 1 ? 'team' : 'solo'
  return `${effort.direction}:${effort.category}:${effort.style}:${team}`
}

/**
 * Rank the efforts in one bucket: fastest first, ties broken by who did it
 * first, because the later runner did not take anything off the earlier one.
 */
export function rankBucket<T extends RecordEffort>(efforts: T[]): (T & { rank: number })[] {
  return efforts
    .filter(effort => RANKED_STATUSES.includes(effort.status) && Number(effort.elapsedSeconds) > 0)
    .sort((a, b) =>
      (a.elapsedSeconds as number) - (b.elapsedSeconds as number)
      || Date.parse(a.startedAt) - Date.parse(b.startedAt)
      || a.id - b.id)
    .map((effort, index) => ({ ...effort, rank: index + 1 }))
}

export interface RecordBoard {
  key: string
  direction: RecordDirection
  category: RecordCategory
  style: RecordStyle
  team: boolean
  entries: (RecordEffort & { rank: number })[]
}

/**
 * Group a route's efforts into the boards a trail page renders, ordered the
 * way they are read: standard direction first, then by category, then from
 * the most assisted style to the least.
 */
export function buildRecordBoards(efforts: RecordEffort[]): RecordBoard[] {
  const buckets = new Map<string, RecordEffort[]>()
  for (const effort of efforts) {
    const key = recordBucketKey(effort)
    const bucket = buckets.get(key)
    if (bucket)
      bucket.push(effort)
    else
      buckets.set(key, [effort])
  }

  const boards: RecordBoard[] = []
  for (const [key, bucket] of buckets) {
    const entries = rankBucket(bucket)
    if (!entries.length)
      continue
    const [direction, category, style, team] = key.split(':')
    boards.push({
      key,
      direction: direction as RecordDirection,
      category: category as RecordCategory,
      style: style as RecordStyle,
      team: team === 'team',
      entries,
    })
  }

  const directionOrder = (value: RecordDirection) => RECORD_DIRECTIONS.indexOf(value)
  const categoryOrder = (value: RecordCategory) => RECORD_CATEGORIES.indexOf(value)
  const styleOrder = (value: RecordStyle) => RECORD_STYLES.indexOf(value)
  return boards.sort((a, b) =>
    directionOrder(a.direction) - directionOrder(b.direction)
    || Number(a.team) - Number(b.team)
    || categoryOrder(a.category) - categoryOrder(b.category)
    || styleOrder(a.style) - styleOrder(b.style))
}

/**
 * The overall fastest time on the route, ignoring style and category.
 *
 * This is what a route page headlines, and what "the FKT" means when said
 * without qualification.
 */
export function outrightRecord(efforts: RecordEffort[]): (RecordEffort & { rank: number }) | null {
  return rankBucket(efforts)[0] ?? null
}

/**
 * Whether a time is a headline record for its style — that is, whether it also
 * beats every more restrictive style on the same route and direction.
 *
 * A supported time slower than the standing unsupported time still belongs on
 * the supported board, but it is not "the fastest known time" for anything,
 * and labelling it that way is the thing that discredits a records board.
 */
export function beatsMoreRestrictiveStyles(effort: RecordEffort, others: RecordEffort[]): boolean {
  const seconds = Number(effort.elapsedSeconds)
  if (!Number.isFinite(seconds) || seconds <= 0)
    return false
  const stricter = RECORD_STYLES.slice(RECORD_STYLES.indexOf(effort.style) + 1)
  if (!stricter.length)
    return true
  return !others.some(other =>
    other.id !== effort.id
    && other.direction === effort.direction
    && other.category === effort.category
    && (Number(other.teamSize) > 1) === (Number(effort.teamSize) > 1)
    && stricter.includes(other.style)
    && RANKED_STATUSES.includes(other.status)
    && Number(other.elapsedSeconds) > 0
    && Number(other.elapsedSeconds) <= seconds)
}

/**
 * Whether a time is *the* record, as a page should label it.
 *
 * Two conditions, and both are load-bearing. It has to be the fastest in its
 * own bucket — a second-place unsupported time passes
 * `beatsMoreRestrictiveStyles` trivially, since nothing is stricter than
 * unsupported, and would otherwise be captioned "fastest known time" while
 * sitting directly below a faster one. And it has to beat every stricter
 * style, or the caption claims something the route's own board contradicts.
 */
export function isHeadlineRecord(effort: RecordEffort, all: RecordEffort[]): boolean {
  const bucketKey = recordBucketKey(effort)
  const bucket = rankBucket(all.filter(other => recordBucketKey(other) === bucketKey))
  if (bucket[0]?.id !== effort.id)
    return false
  return beatsMoreRestrictiveStyles(effort, all)
}

/**
 * Evidence is what separates a record from a claim.
 *
 * At least one machine-readable trace is required — a GPS file or a link to
 * the activity on a platform that recorded it. A trip report is strongly
 * encouraged but never sufficient on its own, and an attempt still running
 * is exempt because its evidence does not exist yet.
 */
export function evidenceIsSufficient(effort: {
  status: RecordStatus
  activityId?: number | null
  evidenceUrl?: string | null
  gpxUrl?: string | null
}): boolean {
  if (effort.status === 'in_progress' || effort.status === 'dnf')
    return true
  return Boolean(effort.activityId || effort.evidenceUrl || effort.gpxUrl)
}

/** Hosts whose activity links are a trace rather than a photo of one. */
const TRACE_HOSTS = [
  'strava.com',
  'connect.garmin.com',
  'app.komoot.com',
  'komoot.com',
  'suunto.com',
  'coros.com',
  'trainingpeaks.com',
  'ridewithgps.com',
  'wildloop.app',
]

/**
 * Accept an evidence link only if it is an https URL on a platform that
 * actually holds the recording. A link to a blog post about the run is a
 * trip report, not a trace, and the distinction is the whole point of asking.
 */
export function normalizeEvidenceUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim())
    return null
  let parsed: URL
  try {
    parsed = new URL(raw.trim())
  }
  catch {
    return null
  }
  if (parsed.protocol !== 'https:')
    return null
  const host = parsed.hostname.replace(/^www\./, '').toLowerCase()
  if (!TRACE_HOSTS.some(allowed => host === allowed || host.endsWith(`.${allowed}`)))
    return null
  return parsed.toString()
}

/**
 * A tracker link is read while an attempt is still out there, so it is held
 * to a lower bar than evidence — any https link works — but it is still
 * normalized so a typo cannot inject a `javascript:` URL into the board.
 */
export function normalizeTrackerUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim())
    return null
  try {
    const parsed = new URL(raw.trim())
    return parsed.protocol === 'https:' ? parsed.toString() : null
  }
  catch {
    return null
  }
}

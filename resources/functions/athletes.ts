/**
 * The athlete directory, independent of how it is drawn.
 *
 * The web page lays it out as cards with a follow button; the native screen as
 * grouped rows. What they must agree on is who is in the list, how each one's
 * record is put into words, and which verb follows somebody — a native screen
 * guessing `POST` where the API wants `PUT` is a button that looks like it
 * worked.
 */

import { routeShapeFor } from './route-shape'

export interface AthleteRow {
  id: number
  name: string
  avatar: string | null
  nearYou: boolean
  activityCount: number
  followerCount: number
  territoriesOwned: number
  totalAreaOwned: number
}

/** The API's rows, with the numbers coerced and a name that is never blank. */
export function athleteRowsFrom(payload: unknown): AthleteRow[] {
  const list = (payload as { athletes?: unknown[] })?.athletes
  if (!Array.isArray(list))
    return []

  return list.map((entry) => {
    const row = entry as Record<string, unknown>
    return {
      id: Number(row.id) || 0,
      name: String(row.name || 'Athlete'),
      avatar: typeof row.avatar === 'string' && row.avatar ? row.avatar : null,
      nearYou: Boolean(row.nearYou),
      activityCount: Number(row.activityCount) || 0,
      followerCount: Number(row.followerCount) || 0,
      territoriesOwned: Number(row.territoriesOwned) || 0,
      totalAreaOwned: Number(row.totalAreaOwned) || 0,
    }
  })
}

/** Square metres as the square kilometres a territory is counted in. */
export function areaKm2(squareMetres: number): string {
  return ((Number(squareMetres) || 0) / 1_000_000).toFixed(2)
}

/** "6 activities", counting one as one. */
export function athleteActivityText(row: Pick<AthleteRow, 'activityCount'>): string {
  return row.activityCount === 1 ? '1 activity' : `${row.activityCount} activities`
}

/** "4 followers", likewise. */
export function athleteFollowerText(row: Pick<AthleteRow, 'followerCount'>): string {
  return row.followerCount === 1 ? '1 follower' : `${row.followerCount} followers`
}

/**
 * "3 held · 1.66 km²", or nothing.
 *
 * Empty for somebody holding no ground, rather than "0 held · 0.00 km²" — which
 * says the same thing at four times the length and puts a zero where an
 * achievement goes. Territory is what distinguishes this from a run tracker, so
 * the row carries it whenever there is any.
 */
export function athleteTerritoryText(row: Pick<AthleteRow, 'territoriesOwned' | 'totalAreaOwned'>): string {
  if (row.territoriesOwned <= 0)
    return ''
  return `${row.territoriesOwned} held · ${areaKm2(row.totalAreaOwned)} km²`
}

/**
 * The three parts as one line, for a screen that draws them as one.
 *
 * The parts are separate because the web page puts a styled separator and a
 * flag icon between them; a native row is one `Text`. Same words either way.
 */
export function athleteStatsLine(row: AthleteRow): string {
  return [athleteActivityText(row), athleteFollowerText(row), athleteTerritoryText(row)]
    .filter(Boolean)
    .join(' · ')
}

/** The heading over a search: the count, and the query it is for. */
export function athleteMatchLine(count: number, query: string): string {
  const trimmed = query.trim()
  const matches = count === 1 ? 'One match' : `${count} matches`
  return trimmed ? `${matches} for “${trimmed}”` : matches
}

/**
 * The request that follows or unfollows somebody.
 *
 * `PUT` to follow, `DELETE` to stop: the verb carries the direction, so there
 * is no body to get wrong and no second endpoint to keep in step.
 */
export function followRequest(athleteId: number, following: boolean): { path: string, method: 'PUT' | 'DELETE' } {
  return { path: `/api/users/${athleteId}/follow`, method: following ? 'PUT' : 'DELETE' }
}

/** The directory's own search, which is also its browse list when the query is empty. */
export function athleteSearchPath(query: string): string {
  return `/api/users/search?q=${encodeURIComponent(query.trim())}`
}

// ── One athlete's own page ───────────────────────────────────────────────────

/**
 * The reading half of `/athlete/:id`, added when it was promoted to a native
 * screen. Three screens already opened that path — the directory, the
 * leaderboard and the territory map — so it closes three hand-offs at once.
 */

export function athletePath(id: number): string {
  return `/api/users/${encodeURIComponent(String(id))}`
}

export interface AthleteProfile {
  id: number
  name: string
  location: string
  bio: string
  avatar: string | null
  totalDistance: number
  activityCount: number
  totalElevation: number
  territoriesOwned: number
  followerCount: number
  followingCount: number
  recentActivities: any[]
}

/**
 * One athlete, flattened.
 *
 * `/api/users/{id}` answers an *envelope*, not a flat athlete: identity under
 * `user`, numbers under `stats`, and only the follow counts at the top. A
 * screen reading `payload.name` finds nothing and shows a nameless profile,
 * so the flattening happens once, here.
 */
export function athleteProfileFrom(payload: unknown): AthleteProfile | null {
  const envelope = payload as any
  const user = envelope?.user
  if (!user || user.id == null)
    return null

  const stats = envelope.stats ?? {}
  return {
    id: Number(user.id),
    name: String(user.name ?? 'Athlete'),
    location: String(user.location ?? ''),
    bio: String(user.bio ?? ''),
    avatar: user.avatar ?? null,
    totalDistance: Number(stats.totalDistance ?? 0),
    activityCount: Number(stats.activityCount ?? 0),
    totalElevation: Number(stats.totalElevation ?? 0),
    territoriesOwned: Number(stats.territoriesOwned ?? 0),
    followerCount: Number(envelope.followerCount ?? 0),
    followingCount: Number(envelope.followingCount ?? 0),
    recentActivities: Array.isArray(envelope.recentActivities) ? envelope.recentActivities : [],
  }
}

export function athleteDistanceText(profile: AthleteProfile | null): string {
  return `${(profile?.totalDistance ?? 0).toFixed(1)} mi`
}

export function athleteElevationText(profile: AthleteProfile | null): string {
  return `${(profile?.totalElevation ?? 0).toLocaleString('en-US')} ft`
}

export function followLabel(following: boolean): string {
  return following ? 'Following' : 'Follow'
}

/**
 * A follower count after an optimistic toggle has settled.
 *
 * The clubs screen got this wrong and a refused join took 48 members to 47:
 * it counted from the direction of the *tap* rather than from the state before
 * it, so a rollback moved the number the way the tap had. `was` is that
 * original state, and a server count always wins when there is one.
 */
export function settledFollowerCount(
  was: boolean,
  now: boolean,
  countBefore: number,
  serverCount?: number | null,
): number {
  if (typeof serverCount === 'number')
    return Math.max(0, serverCount)
  if (now === was)
    return Math.max(0, countBefore)
  return Math.max(0, now ? countBefore + 1 : countBefore - 1)
}

export function blockRequest(athleteId: number, blocked: boolean): { path: string, method: 'PUT' | 'DELETE' } {
  return { path: `/api/users/${encodeURIComponent(String(athleteId))}/block`, method: blocked ? 'PUT' : 'DELETE' }
}

export const REPORT_REASONS = ['harassment', 'spam', 'unsafe', 'cheating', 'privacy', 'other'] as const
export type ReportReason = typeof REPORT_REASONS[number]

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  harassment: 'Harassment',
  spam: 'Spam',
  unsafe: 'Unsafe behaviour',
  cheating: 'Cheating',
  privacy: 'Privacy',
  other: 'Something else',
}

export function reportRequest(athleteId: number, reason: ReportReason): {
  path: string
  body: { subject_type: 'user', subject_id: number, reason: ReportReason }
} {
  return {
    path: '/api/reports',
    body: { subject_type: 'user', subject_id: athleteId, reason },
  }
}

/** One recent activity, as a line. */
export function recentActivityLine(activity: any): string {
  const type = String(activity?.activityType ?? 'Activity')
  const trail = activity?.trailName ? ` · ${activity.trailName}` : ''
  return `${type}${trail}`
}

export function recentActivityStats(activity: any): string {
  const miles = Number(activity?.distance ?? 0).toFixed(1)
  const feet = Number(activity?.elevationGain ?? 0).toLocaleString('en-US')
  return `${miles} mi · ${feet} ft`
}

/**
 * The box a recent activity's route is drawn into on a native profile row.
 *
 * Its own box rather than the trails screen's, and deliberately not the web
 * page's either: that container is square (100x100, pad 12) and this row is a
 * 96x64 strip. The *projection* is what must not drift — `routeShapeFor`,
 * which squashes longitude by the cosine of the latitude so an east-west
 * ridge is not drawn twice as wide as it is — and both call it.
 */
export const ACTIVITY_ROUTE_BOX = { width: 96, height: 64, pad: 8 } as const

/**
 * A recent activity's route as SVG points, or '' when it has none.
 *
 * Reads `route`, which is the field `/api/users/{id}` puts on a recent
 * activity — the web page reads the same one.
 */
export function activityRoutePoints(activity: any): string {
  const route = activity?.route
  if (!Array.isArray(route) || route.length < 2)
    return ''
  const shape = routeShapeFor(route, ACTIVITY_ROUTE_BOX.width, ACTIVITY_ROUTE_BOX.height, ACTIVITY_ROUTE_BOX.pad)
  return shape?.points ?? ''
}

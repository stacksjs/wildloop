// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// Lists activities for the feed / profile. Optional ?user_id filter. Joins the
// owner's name and the trail name so the feed can render without extra lookups.
// The ORM is snake_case; the response is camelCase for the frontend.

import { Auth } from '@stacksjs/auth'

import UserPrivacySetting from '../../Models/UserPrivacySetting'

function parseSplits(raw: string | null): Array<{ mile: number, pace: string, elev: number }> {
  if (!raw)
    return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

/** Longest title the feed lays out on one line before it has to clamp. */
const MAX_TITLE_LENGTH = 80

/**
 * The part of the day a run happened in, from its local hour.
 *
 * A feed is read in reverse-chronological order, so the date is already
 * established by position and by the "3h ago" under the name. What is missing
 * is the character of the run, and "Evening" carries more of that than
 * "9/9/2026" ever did.
 */
function timeOfDay(completedAt: string | null): string {
  if (!completedAt)
    return ''

  const hour = new Date(completedAt).getHours()
  if (!Number.isFinite(hour))
    return ''

  if (hour < 5)
    return 'Night'
  if (hour < 12)
    return 'Morning'
  if (hour < 17)
    return 'Afternoon'
  if (hour < 21)
    return 'Evening'
  return 'Night'
}

/**
 * What the activity is called in the feed.
 *
 * In order of preference:
 *
 *  1. What the athlete wrote. A note is a title someone chose, and no rule
 *     here will ever beat "Marin Headlands long run".
 *  2. Where it happened. A trail name is the next most useful thing.
 *  3. When it happened, as a part of the day.
 *
 * The previous version skipped straight to `Trail Run, 9/9/2026` for anything
 * without a trail, which is a row in a database rather than a title — and it
 * repeated a date the feed had already shown as "3h ago" directly above it.
 */
function titleFor(
  activityType: string,
  trailName: string | null,
  completedAt: string | null,
  notes: string | null,
): string {
  const note = (notes ?? '').split('\n')[0]?.trim() ?? ''
  if (note)
    return note.length > MAX_TITLE_LENGTH ? `${note.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…` : note

  if (trailName)
    return `${activityType} at ${trailName}`

  const when = timeOfDay(completedAt)
  return when ? `${when} ${activityType}` : activityType
}

/**
 * Points kept per feed route.
 *
 * The preview is drawn a few hundred pixels wide, where a thousand-point track
 * and a fifty-point one are the same picture — but a hundred activities' worth
 * of full tracks is megabytes of JSON for a screen that shows the shape and
 * nothing else.
 */
const ROUTE_PREVIEW_POINTS = 48

interface RoutePoint { lat: number, lng: number }

/**
 * A trail's stored geometry, as `[[lat, lng], …]`.
 *
 * Not GeoJSON, despite the neighbouring `geoJsonToCoordinates`: the ingest
 * writes a plain array of pairs, latitude first.
 */
function parseTrailGeometry(geometry: unknown): RoutePoint[] {
  if (typeof geometry !== 'string' || geometry.length < 2)
    return []

  try {
    const parsed = JSON.parse(geometry)
    if (!Array.isArray(parsed))
      return []

    return parsed
      .filter((point: unknown): point is [number, number] =>
        Array.isArray(point) && point.length >= 2
        && Number.isFinite(point[0]) && Number.isFinite(point[1]))
      .map(point => ({ lat: point[0], lng: point[1] }))
  }
  catch {
    // Geometry is ingested from third parties; a malformed row costs this one
    // card its picture, not the whole feed its response.
    return []
  }
}

/** Thin a route to at most `max` points, keeping both ends. */
function thinRoute(route: RoutePoint[], max: number): RoutePoint[] {
  if (route.length <= max)
    return route

  const step = (route.length - 1) / (max - 1)
  const out: RoutePoint[] = []
  for (let index = 0; index < max; index++)
    out.push(route[Math.round(index * step)]!)

  return out
}

export default new Action({
  name: 'Activity Index',
  description: 'List activities (optionally filtered by user) for the feed',
  method: 'GET',

  async handle(request) {
    const userId = request.get<number>('user_id')
    const page = readPageParams(request, { defaultLimit: 100, maxLimit: 500 })

    try {
      // The session drives visibility; `user_id` above filters the profile and
      // never grants viewer permissions.
      const viewerId = (await Auth.user().catch(() => null))?.id ?? null
      const viewerFollowing = viewerId !== null
        ? new Set(((await Follow.where('follower_id', '=', viewerId).get()) ?? []).map((f: any) => f.following_id))
        : new Set<number>()
      const blockedIds = await blockedUserIdsFor(viewerId)

      const query = userId
        ? Activity.where('user_id', '=', userId)
        : Activity.query()
      const allRows = (await query.orderBy('completed_at', 'desc').get()) ?? []
      const rows = allRows.filter((a: any) => canViewActivity(a, viewerId, viewerFollowing, blockedIds))

      // Batch-load owners + trails so the feed gets names without N+1 lookups.
      const userIds = [...new Set(rows.map((a: any) => a.user_id).filter(Boolean))]
      const trailIds = [...new Set(rows.map((a: any) => a.trail_id).filter(Boolean))]
      const users = userIds.length ? await User.whereIn('id', userIds).get() : []
      const trails = trailIds.length ? await Trail.whereIn('id', trailIds).get() : []
      const userName = new Map(users.map((u: any) => [u.id, u.name]))
      const trailName = new Map(trails.map((t: any) => [t.id, t.name]))
      const trailGeometry = new Map(trails.map((t: any) => [t.id, t.geometry]))

      /*
       * Route previews.
       *
       * The feed used to look these up in the browser's own store, which holds
       * the two hundred featured trails the catalog page loads. Against a
       * catalog of ~600,000 that never matches: an activity is almost never on
       * a featured trail, so every card in the feed fell back to an empty grey
       * box where its picture should be.
       *
       * The server has the answer in hand — it has already batch-loaded these
       * trails to get their names — so it sends the shape with the activity.
       *
       * Privacy settings are batch-loaded for the same reason the names are:
       * one query rather than one per card.
       */
      const ownerIds = [...new Set(rows.map((a: any) => a.user_id).filter(Boolean))]
      const privacyRows = ownerIds.length
        ? ((await UserPrivacySetting.whereIn('user_id', ownerIds).get().catch(() => [])) as any[])
        : []
      const hideMetresByUser = new Map(privacyRows.map(row => [row.user_id, row.hide_start_end_meters ?? 400]))

      const routeFor = (activity: any): Array<[number, number]> => {
        // The athlete's own recorded track first: it is where they actually
        // went. The trail's shape is the fallback for a manual entry, which
        // has no track of its own but was still run somewhere.
        const exact = activity.gpx_data
          ? (parseGpsData(activity.gpx_data) as RoutePoint[])
          : parseTrailGeometry(trailGeometry.get(activity.trail_id))

        if (exact.length < 2)
          return []

        // Somebody else's run has its start and end blurred, exactly as the
        // detail page does — a feed is a worse place to leak a front door.
        const masked = viewerId === activity.user_id
          ? exact
          : maskRouteEndpoints(exact, hideMetresByUser.get(activity.user_id) ?? 400)

        // Emitted as [lat, lng] pairs, which is both what the preview
        // renderer indexes and about 40% less JSON than named keys across a
        // hundred activities.
        return thinRoute(masked, ROUTE_PREVIEW_POINTS).map(point => [point.lat, point.lng] as [number, number])
      }

      // Historical/dev databases can contain activities whose athlete was
      // removed before foreign keys were enabled. Do not emit /athlete/null
      // links or an actionable "Unknown" account into the social feed.
      const ownedRows = rows.filter((activity: any) => userName.has(activity.user_id))

      const activities = ownedRows.map((a: any) => {
        const tName = a.trail_id ? (trailName.get(a.trail_id) ?? null) : null
        return {
          id: a.id,
          userId: a.user_id,
          userName: userName.get(a.user_id),
          trailId: a.trail_id,
          trailName: tName,
          title: titleFor(a.activity_type, tName, a.completed_at, a.notes),
          activityType: a.activity_type,
          distance: a.distance,
          duration: a.duration,
          movingTime: a.moving_time ?? a.duration,
          pace: a.pace,
          elevationGain: a.elevation ?? 0,
          splits: parseSplits(a.splits),
          calories: Math.round((a.distance ?? 0) * 95),
          kudosCount: a.kudos_count ?? 0,
          route: routeFor(a),
          notes: a.notes,
          hasGps: !!a.gpx_data,
          visibility: a.visibility ?? 'public',
          completedAt: a.completed_at,
          createdAt: a.created_at,
        }
      })

      const { items, meta } = paginate(activities, page)
      return response.json({ activities: items, meta })
    }
    catch (error) {
      console.error('[activities] index failed:', error)
      return response.json({ activities: [], error: 'Failed to fetch activities' }, 500)
    }
  },
})

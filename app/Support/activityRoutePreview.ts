/**
 * The small drawing of an activity's route that a card shows beside it.
 *
 * Shared by every list that shows other people's activities — the feed and an
 * athlete's page — so a route is blurred the same way wherever it appears. The
 * athlete page used to send no shape at all, while the feed sent a masked one;
 * two copies of this logic would sooner or later disagree about the masking,
 * and the one that forgot would be the one leaking somebody's front door.
 */

import { parseGpsData } from '../../resources/functions/gpx'
import { primaryRoutePart } from '../../resources/functions/trail-geometry'
import { maskRouteEndpoints } from '../../resources/functions/visibility'
import UserPrivacySetting from '../Models/UserPrivacySetting'

/**
 * Points kept per preview.
 *
 * The preview is drawn a few hundred pixels wide, where a thousand-point track
 * and a fifty-point one are the same picture — but a hundred activities' worth
 * of full tracks is megabytes of JSON for a screen that shows the shape and
 * nothing else.
 */
export const ROUTE_PREVIEW_POINTS = 48

/** How much of each end is hidden when an athlete has not said otherwise. */
const DEFAULT_HIDE_METRES = 400

interface RoutePoint { lat: number, lng: number }

/**
 * A trail's main line from its stored geometry.
 *
 * Not GeoJSON: the ingest writes plain pairs, latitude first — `[[lat, lng],
 * …]`, or one such array per part for a trail in several pieces. A card draws
 * the main part only; gluing the parts together would draw a straight line
 * between them. Malformed geometry (it is ingested from third parties) costs
 * one card its picture, not the whole response.
 */
export function trailMainLine(geometry: unknown): RoutePoint[] {
  return primaryRoutePart(geometry).map(([lat, lng]) => ({ lat, lng }))
}

/** Thin a route to at most `max` points, keeping both ends. */
export function thinRoute<T>(route: T[], max: number): T[] {
  if (route.length <= max)
    return route

  const step = (route.length - 1) / (max - 1)
  const out: T[] = []
  for (let index = 0; index < max; index++)
    out.push(route[Math.round(index * step)]!)

  return out
}

/**
 * Each athlete's "hide the ends of my routes" distance, in metres, in one
 * query rather than one per card.
 */
export async function hiddenEndMetres(userIds: number[]): Promise<Map<number, number>> {
  const ids = [...new Set(userIds.filter(Boolean))]
  if (ids.length === 0)
    return new Map()

  const rows = ((await UserPrivacySetting.whereIn('user_id', ids).get().catch(() => [])) ?? []) as any[]
  return new Map(rows.map(row => [row.user_id, row.hide_start_end_meters ?? DEFAULT_HIDE_METRES]))
}

export interface RoutePreviewContext {
  /** Who is looking. Their own routes are drawn whole. */
  viewerId: number | null
  /** Stored geometry by trail id, for activities logged by hand on a trail. */
  trailGeometry: Map<number, unknown>
  /** From hiddenEndMetres(). */
  hideMetres: Map<number, number>
}

/**
 * `[lat, lng]` pairs for one activity's card, or `[]` when there is nothing
 * honest to draw.
 */
export function activityRoutePreview(activity: any, context: RoutePreviewContext): Array<[number, number]> {
  // The athlete's own recorded track first: it is where they actually went.
  // The trail's shape is the fallback for a manual entry, which has no track
  // of its own but was still run somewhere.
  const exact: RoutePoint[] = activity.gpx_data
    ? (parseGpsData(activity.gpx_data) as RoutePoint[])
    : trailMainLine(context.trailGeometry.get(activity.trail_id))

  if (exact.length < 2)
    return []

  // Somebody else's run has its start and end blurred, exactly as the detail
  // page does — a list is a worse place to leak a front door.
  const masked = context.viewerId === activity.user_id
    ? exact
    : maskRouteEndpoints(exact, context.hideMetres.get(activity.user_id) ?? DEFAULT_HIDE_METRES)

  // Masking trims each end, which on a short trail can leave fewer than two
  // points. Answering with nothing lets the card show its placeholder, and is
  // emphatically not a reason to fall back to the unmasked line: those
  // endpoints are what the masking exists to withhold.
  if (masked.length < 2)
    return []

  // [lat, lng] pairs: what the preview renderer indexes, and about 40% less
  // JSON than named keys across a hundred activities.
  return thinRoute(masked, ROUTE_PREVIEW_POINTS).map(point => [point.lat, point.lng] as [number, number])
}

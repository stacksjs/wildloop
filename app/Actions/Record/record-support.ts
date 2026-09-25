// Shared shaping and lookup for the route-records endpoints.
//
// Every records endpoint answers the same two questions — "who ran it" and
// "which route" — so the name and trail joins live here rather than being
// re-derived (differently, and eventually inconsistently) in six actions.

import RouteEffort from '../../Models/RouteEffort'
import Trail from '../../Models/Trail'
import User from '../../Models/User'

import {
  type RecordCategory,
  type RecordDirection,
  type RecordEffort,
  type RecordStatus,
  type RecordStyle,
  RECORD_CATEGORIES,
  RECORD_DIRECTIONS,
  RECORD_STATUSES,
  RECORD_STYLES,
  formatElapsed,
  recordPace,
} from '../../../resources/functions/route-records'
import { avatarOf } from '../../Support/avatars'

export interface ShapedEffort extends RecordEffort {
  trailId: number
  trailName: string
  trailDistance: number
  trailLocation: string | null
  activityId: number | null
  evidenceUrl: string | null
  gpxUrl: string | null
  trackerUrl: string | null
  tripReport: string | null
  elapsedLabel: string
  paceLabel: string
  reviewNote: string | null
  reviewedAt: string | null
  createdAt: string | null
}

/** Enum guards. Unknown values are rejected rather than coerced to a default:
 *  a filter that silently answers a different question is worse than a 422. */
export function asStyle(value: unknown): RecordStyle | null {
  return RECORD_STYLES.includes(value as RecordStyle) ? value as RecordStyle : null
}

export function asCategory(value: unknown): RecordCategory | null {
  return RECORD_CATEGORIES.includes(value as RecordCategory) ? value as RecordCategory : null
}

export function asDirection(value: unknown): RecordDirection | null {
  return RECORD_DIRECTIONS.includes(value as RecordDirection) ? value as RecordDirection : null
}

export function asStatus(value: unknown): RecordStatus | null {
  return RECORD_STATUSES.includes(value as RecordStatus) ? value as RecordStatus : null
}

/**
 * Attach athlete names and route metadata to a page of efforts.
 *
 * Two batched lookups rather than a per-row join: a board or a feed is at most
 * a few hundred rows, and the alternative is N+1 queries against a trails
 * table with 593,000 rows in it.
 */
export async function shapeEfforts(rows: any[]): Promise<ShapedEffort[]> {
  if (!rows.length)
    return []

  const userIds = [...new Set(rows.map(row => row.user_id).filter(Boolean))]
  const trailIds = [...new Set(rows.map(row => row.trail_id).filter(Boolean))]

  const users = userIds.length ? (await User.whereIn('id', userIds).get()) ?? [] : []
  const trails = trailIds.length ? (await Trail.whereIn('id', trailIds).get()) ?? [] : []
  const names = new Map(users.map((user: any) => [user.id, user.name]))
  const avatars = new Map(users.map((user: any) => [user.id, avatarOf(user)]))
  const trailById = new Map(trails.map((trail: any) => [trail.id, trail]))

  return rows.map((row) => {
    const trail = trailById.get(row.trail_id)
    const distance = Number(trail?.distance ?? 0)
    const seconds = row.elapsed_seconds == null ? null : Number(row.elapsed_seconds)
    return {
      id: row.id,
      userId: row.user_id,
      userName: names.get(row.user_id) ?? 'Athlete',
      userAvatar: avatars.get(row.user_id) ?? null,
      trailId: row.trail_id,
      trailName: trail?.name ?? 'Unknown route',
      trailDistance: distance,
      trailLocation: trail?.location ?? null,
      activityId: row.activity_id ?? null,
      style: row.style,
      category: row.category,
      direction: row.direction,
      teamSize: Number(row.team_size ?? 1),
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? null,
      elapsedSeconds: seconds,
      elapsedLabel: formatElapsed(seconds),
      paceLabel: recordPace(distance, seconds),
      evidenceUrl: row.evidence_url ?? null,
      gpxUrl: row.gpx_url ?? null,
      trackerUrl: row.tracker_url ?? null,
      tripReport: row.trip_report ?? null,
      reviewNote: row.review_note ?? null,
      reviewedAt: row.reviewed_at ?? null,
      createdAt: row.created_at ?? null,
    }
  })
}

/**
 * Every effort filed on one route, newest first.
 *
 * Boards are built in memory from this rather than by one query per bucket:
 * a route has at most a few hundred efforts across its whole history, and a
 * query per (direction × category × style × team) is 54 round-trips to render
 * one page.
 */
export async function effortsForTrail(trailId: number): Promise<any[]> {
  return (await RouteEffort.where('trail_id', '=', trailId).get()) ?? []
}

/**
 * Whether a caller may see the private parts of an effort — the review note
 * and an unverified claim. The athlete and an admin can; nobody else needs to.
 */
export function canSeePrivateEffort(effort: any, viewerId: number | null, isAdmin: boolean): boolean {
  return isAdmin || (viewerId !== null && effort.user_id === viewerId)
}

/**
 * Statuses a stranger is allowed to see.
 *
 * A rejected claim is hidden from everyone but its author and the reviewers:
 * publishing "we did not believe this person" is a reputational act the site
 * has no business performing automatically.
 */
export const PUBLIC_STATUSES: readonly RecordStatus[] = ['in_progress', 'dnf', 'pending', 'verified']

/**
 * The signed-in user's role names.
 *
 * RBAC reads through a store the HTTP layer configures on boot; installing it
 * lazily keeps these actions working in contexts that never ran that boot
 * (the CLI, the test harness) instead of throwing "RBAC store not configured".
 * Mirrors AdminOverviewAction, which does the same for the same reason.
 */
export async function isAdminUser(userId: number | null): Promise<boolean> {
  if (!userId)
    return false
  try {
    const { createBqbRbacStore, Rbac } = await import('@stacksjs/auth')
    Rbac.setStore(createBqbRbacStore())
    const roles = await Rbac.getUserRoles(userId)
    return (roles ?? []).some((role: any) => String(role?.name ?? '') === 'admin')
  }
  catch {
    return false
  }
}

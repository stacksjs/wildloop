import type { SqlTag } from './trailViews'
import { db } from '@stacksjs/orm'
import { primaryRoutePart } from '../../resources/functions/trail-geometry'
import { licenseLink, licenseVerdict } from './photoLicenses'

/**
 * The review side of the photo queue: what /admin/photos lists, and what a
 * decision does.
 *
 * The rule the whole queue exists for: a photograph becomes a trail's cover
 * only because a person looked at it and said so. The nightly job
 * (trailPhotoQueue.ts) writes candidates as pending and never anything else;
 * this is the only code that writes `approved`, and only from a reviewer's
 * request, with their id on the row.
 */

export const DECISIONS = ['approve', 'reject', 'reopen'] as const
export type PhotoDecision = typeof DECISIONS[number]

/** Whether a request's `decision` is one this queue knows, narrowed for the caller. */
export function isPhotoDecision(value: unknown): value is PhotoDecision {
  return typeof value === 'string' && (DECISIONS as readonly string[]).includes(value)
}

/** Points of the trail line sent to the page: a picture, not a map download. */
const LINE_POINTS = 80

export interface QueueCandidate {
  id: number
  title: string
  url: string
  pageUrl: string
  credit: string
  license: string
  licenseUrl: string
  matched: string[]
}

export interface QueueTrail {
  id: number
  name: string
  location: string
  state: string
  lat: number
  lng: number
  distance: number
  priority: number
  /** `[lat, lng]` pairs of the main line, thinned, for the reviewer to see where it runs. */
  line: Array<[number, number]>
  candidates: QueueCandidate[]
}

export interface PhotoQueuePage {
  trails: QueueTrail[]
  /** Trails with at least one candidate waiting, not only this page of them. */
  pendingTrails: number
  pendingCandidates: number
}

const ormSql: SqlTag = async (strings, ...values) => ((await db.sql(strings, ...values).execute()) as any[]) ?? []

function thin<T>(points: T[], max: number): T[] {
  if (points.length <= max)
    return points
  const step = (points.length - 1) / (max - 1)
  return Array.from({ length: max }, (_, index) => points[Math.round(index * step)]!)
}

/**
 * The trails waiting for a decision, most wanted first, each with its
 * candidates. A trail with an approved photo already has its cover and drops
 * out, even if other files for it are still pending.
 */
export async function pendingPhotoQueue(options: { limit?: number } = {}, sql: SqlTag = ormSql): Promise<PhotoQueuePage> {
  const limit = Math.min(50, Math.max(1, Math.floor(Number(options.limit) || 20)))

  const trails = await sql`
    SELECT t.id, t.name, t.location, t.state, t.latitude, t.longitude, t.distance, t.geometry, MAX(c.priority) AS priority
    FROM trail_photo_candidates c
    JOIN trails t ON t.id = c.trail_id
    WHERE c.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM trail_photo_candidates a WHERE a.trail_id = c.trail_id AND a.status = 'approved')
    GROUP BY t.id
    ORDER BY priority DESC, t.id ASC
    LIMIT ${limit}
  ` as Array<Record<string, any>>

  const [counts] = await sql`
    SELECT COUNT(DISTINCT c.trail_id) AS trails, COUNT(*) AS candidates
    FROM trail_photo_candidates c
    WHERE c.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM trail_photo_candidates a WHERE a.trail_id = c.trail_id AND a.status = 'approved')
  ` as Array<{ trails: number, candidates: number }>

  const ids = (trails ?? []).map(row => Number(row.id))
  const candidates = ids.length === 0
    ? []
    : await sql`
        SELECT id, trail_id, file_title, url, page_url, credit, license, license_url, matched_words
        FROM trail_photo_candidates
        WHERE status = 'pending' AND trail_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))
        ORDER BY trail_id, length(matched_words) - length(replace(matched_words, ' ', '')) DESC, id ASC
      ` as Array<Record<string, any>>

  const byTrail = new Map<number, QueueCandidate[]>()
  for (const row of candidates ?? []) {
    const list = byTrail.get(Number(row.trail_id)) ?? []
    list.push({
      id: Number(row.id),
      title: String(row.file_title),
      url: String(row.url),
      pageUrl: String(row.page_url),
      credit: String(row.credit),
      license: String(row.license),
      licenseUrl: licenseLink(row.license_url, row.page_url),
      matched: String(row.matched_words ?? '').split(' ').filter(Boolean),
    })
    byTrail.set(Number(row.trail_id), list)
  }

  return {
    trails: (trails ?? []).map(row => ({
      id: Number(row.id),
      name: String(row.name ?? ''),
      location: String(row.location ?? ''),
      state: String(row.state ?? ''),
      lat: Number(row.latitude),
      lng: Number(row.longitude),
      distance: Number(row.distance) || 0,
      priority: Number(row.priority) || 0,
      line: thin(primaryRoutePart(row.geometry), LINE_POINTS),
      candidates: byTrail.get(Number(row.id)) ?? [],
    })),
    pendingTrails: Number(counts?.trails) || 0,
    pendingCandidates: Number(counts?.candidates) || 0,
  }
}

export type DecisionResult =
  | { ok: true, id: number, trailId: number, status: 'approved' | 'rejected' | 'pending' }
  | { ok: false, status: 404 | 422, error: string }

/**
 * Record a reviewer's decision on one candidate.
 *
 * - approve: it becomes the trail's cover. Any photo approved for the trail
 *   before goes back to pending in the same statement, so a trail never
 *   carries two. Refused, whatever the reviewer says, when the licence does
 *   not allow a cover — the row would have to have been edited by hand to
 *   get here, and a person's click does not change the licence.
 * - reject: hidden from the queue and never a cover.
 * - reopen: back to pending, which takes it off the trail if it was the
 *   cover. The undo for a mis-click.
 */
export async function decidePhotoCandidate(
  id: number,
  decision: PhotoDecision,
  reviewerId: number,
  options: { note?: string, at?: Date } = {},
  sql: SqlTag = ormSql,
): Promise<DecisionResult> {
  const [candidate] = await sql`
    SELECT id, trail_id, license, license_url, status FROM trail_photo_candidates WHERE id = ${id}
  ` as Array<{ id: number, trail_id: number, license: string, license_url: string, status: string }>
  if (!candidate)
    return { ok: false, status: 404, error: 'Candidate not found' }

  const trailId = Number(candidate.trail_id)
  const now = (options.at ?? new Date()).toISOString()

  if (decision === 'approve') {
    const verdict = licenseVerdict(candidate.license, candidate.license_url)
    if (!verdict.allowed)
      return { ok: false, status: 422, error: `This photo cannot be a cover: ${verdict.reason}` }

    await sql`
      UPDATE trail_photo_candidates SET
        status = CASE WHEN id = ${id} THEN 'approved' ELSE 'pending' END,
        reviewed_by = CASE WHEN id = ${id} THEN ${reviewerId} ELSE NULL END,
        reviewed_at = CASE WHEN id = ${id} THEN ${now} ELSE NULL END,
        reason = CASE WHEN id = ${id} THEN NULL ELSE reason END,
        updated_at = ${now}
      WHERE trail_id = ${trailId} AND (id = ${id} OR status = 'approved')
    `
    return { ok: true, id, trailId, status: 'approved' }
  }

  if (decision === 'reject') {
    const note = String(options.note ?? '').trim().slice(0, 500)
    await sql`
      UPDATE trail_photo_candidates SET
        status = 'rejected', reviewed_by = ${reviewerId}, reviewed_at = ${now},
        reason = ${note || 'rejected by a reviewer'}, updated_at = ${now}
      WHERE id = ${id}
    `
    return { ok: true, id, trailId, status: 'rejected' }
  }

  // A licence refusal is not the reviewer's to reopen: it would only be
  // refused again on approval.
  const verdict = licenseVerdict(candidate.license, candidate.license_url)
  if (!verdict.allowed)
    return { ok: false, status: 422, error: `This photo cannot be a cover: ${verdict.reason}` }

  await sql`
    UPDATE trail_photo_candidates SET
      status = 'pending', reviewed_by = NULL, reviewed_at = NULL, reason = NULL, updated_at = ${now}
    WHERE id = ${id}
  `
  return { ok: true, id, trailId, status: 'pending' }
}

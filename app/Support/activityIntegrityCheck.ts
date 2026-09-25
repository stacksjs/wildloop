import type { HistoryFinding, NeighbouringActivity } from '../../resources/functions/activity-history'
import type { TrackIntegrityResult } from '../../resources/functions/activity-integrity'
import Activity from '../Models/Activity'
import { checkAgainstHistory } from '../../resources/functions/activity-history'
import { parseDurationToSeconds } from '../../resources/functions/duration'

/**
 * The half of anti-cheat that needs the athlete's other activities.
 *
 * A fabricated track can be internally flawless — plausible speeds, plausible
 * accuracy, a shape that looks like a run — and still impossible in context.
 * Nobody is in two places at once, nobody crosses an ocean between two runs,
 * and nobody records the same trace twice.
 *
 * The rules live in `activity-history` as pure functions so they can be tested
 * without a database. What lives here is the query that feeds them, kept in one
 * place so the window it reads and the indexes it needs stay visible together.
 */

/**
 * How far either side of the activity to look for conflicts.
 *
 * Wide enough to catch an overlap or a transit worth questioning, narrow enough
 * that the indexed range scan stays small for an athlete with years of history.
 */
const WINDOW_HOURS = 24

export interface IntegrityVerdict {
  captureEligible: boolean
  /** Set when a finding disqualifies the capture. */
  reason: string | null
  reviewState: 'none' | 'pending'
  findings: HistoryFinding[]
}

/** The endpoints of a track, for the transit check. */
function endpoints(samples: TrackIntegrityResult['samples']) {
  const usable = samples.filter(sample => Number.isFinite(sample.lat) && Number.isFinite(sample.lng))
  if (usable.length === 0)
    return { startLat: null, startLng: null, endLat: null, endLng: null }

  const first = usable[0]
  const last = usable[usable.length - 1]
  return {
    startLat: first.lat,
    startLng: first.lng,
    endLat: last.lat,
    endLng: last.lng,
  }
}

function epoch(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number')
    return null
  const parsed = typeof value === 'number' ? value : Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Check a pending activity against everything the athlete has already logged.
 *
 * `startedAt` is derived from the track rather than trusted from the client,
 * for the same reason distance and duration are.
 */
export async function verifyAgainstHistory(input: {
  userId: number
  integrity: TrackIntegrityResult
  completedAt: string | null
  captureEligible: boolean
}): Promise<IntegrityVerdict> {
  const { integrity } = input

  if (!input.captureEligible) {
    return { captureEligible: false, reason: null, reviewState: 'none', findings: [] }
  }

  const completedMs = epoch(input.completedAt) ?? Date.now()
  const startedMs = integrity.durationSeconds !== null
    ? completedMs - integrity.durationSeconds * 1000
    : null

  const candidate = {
    startedAt: startedMs,
    completedAt: completedMs,
    fingerprint: integrity.fingerprint,
    ...endpoints(integrity.samples),
  }

  const windowMs = WINDOW_HOURS * 60 * 60 * 1000
  const from = new Date(completedMs - windowMs).toISOString()
  const to = new Date(completedMs + windowMs).toISOString()

  // Two reads rather than one: the athlete's nearby activities, and anybody's
  // activity carrying this exact trace. The second is the interesting
  // duplicate — a shared file, or one athlete uploading another's run — and it
  // is not restricted by user or by time.
  const [nearby, sameTrace] = await Promise.all([
    Activity
      .where('user_id', '=', input.userId)
      .where('completed_at', '>=', from)
      .where('completed_at', '<=', to)
      .get()
      .catch(() => []),
    integrity.fingerprint
      ? Activity
        .where('track_fingerprint', '=', integrity.fingerprint)
        .get()
        .catch(() => [])
      : Promise.resolve([]),
  ])

  const seen = new Set<number>()
  const neighbours: NeighbouringActivity[] = []

  for (const row of [...(nearby as any[]), ...(sameTrace as any[])]) {
    const id = Number(row?.id)
    if (!Number.isFinite(id) || seen.has(id))
      continue
    seen.add(id)

    const rowCompleted = epoch(row?.completed_at)
    // Derived from the stored display duration, because activities carry no
    // seconds column. Without this every neighbour looks instantaneous: its
    // window collapses to a point, and the overlap check can never fire.
    const rowDuration = typeof row?.duration === 'string'
      ? parseDurationToSeconds(row.duration)
      : null

    neighbours.push({
      id,
      startedAt: rowCompleted !== null && rowDuration !== null ? rowCompleted - rowDuration * 1000 : rowCompleted,
      completedAt: rowCompleted,
      startLat: null,
      startLng: null,
      endLat: null,
      endLng: null,
      fingerprint: typeof row?.track_fingerprint === 'string' ? row.track_fingerprint : null,
      captureEligible: !!row?.capture_eligible,
    })
  }

  const findings = checkAgainstHistory(candidate, neighbours)
  const disqualifying = findings.find(finding => finding.disqualifying)

  if (disqualifying) {
    return {
      captureEligible: false,
      reason: disqualifying.detail,
      // Decided, not pending: a duplicate trace and a scored overlap are not
      // judgement calls, and queueing them for review would only bury the
      // cases that are.
      reviewState: 'none',
      findings,
    }
  }

  // A high anomaly score, or a soft finding, means somebody should look — but
  // the capture stands until they do. Holding territory back on a statistic
  // would punish the honest athlete with an unusual run, and they are the ones
  // who notice.
  const suspicious = findings.length > 0 || integrity.anomalyScore >= 0.6

  return {
    captureEligible: true,
    reason: null,
    reviewState: suspicious ? 'pending' : 'none',
    findings,
  }
}

/** The evidence to store alongside the verdict, as one JSON column. */
export function integrityFlagsJson(
  integrity: TrackIntegrityResult,
  findings: HistoryFinding[],
): string | null {
  const flags = [
    ...integrity.anomalySignals.map(signal => ({
      kind: 'anomaly' as const,
      code: signal.code,
      detail: signal.detail,
      weight: signal.weight,
    })),
    ...findings.map(finding => ({
      kind: 'history' as const,
      code: finding.code,
      detail: finding.detail,
      conflictsWith: finding.conflictsWith,
      disqualifying: finding.disqualifying,
    })),
  ]

  return flags.length > 0 ? JSON.stringify(flags) : null
}

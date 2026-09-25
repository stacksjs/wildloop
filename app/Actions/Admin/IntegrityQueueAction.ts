// Auth is imported explicitly: it is NOT in the API server bundle's
// auto-imports, so `Auth.user()` threw at runtime in production while
// type-checking clean against the declarations.
//
// GET /api/admin/integrity-queue (admin) — captures a person should look at.
//
// The anti-cheat pass refuses what is physically impossible and flags what is
// merely improbable. Flagging with nowhere to look is worse than not flagging:
// it lets the team believe something is being checked when nothing is. This is
// where the flagged ones surface, worst first.

import { Auth } from '@stacksjs/auth'
import Activity from '../../Models/Activity'
import { isAdminUser } from '../../Support/routeEfforts'

interface IntegrityFlag {
  kind?: string
  code?: string
  detail?: string
  weight?: number
  conflictsWith?: number
  disqualifying?: boolean
}

function parseFlags(raw: unknown): IntegrityFlag[] {
  if (typeof raw !== 'string' || raw.length === 0)
    return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  }
  catch {
    return []
  }
}

export default new Action({
  name: 'Integrity Queue',
  description: 'Captures flagged for human review, most suspicious first',
  method: 'GET',

  async handle(request) {
    const reviewer = await Auth.user().catch(() => null)
    if (!reviewer)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    // Re-checked here rather than trusted from the route: an endpoint that
    // exposes other athletes' telemetry should not depend on a router
    // registration staying correct.
    if (!await isAdminUser(reviewer.id))
      return response.json({ success: false, error: 'Reviewer access required' }, 403)

    const stateFilter = request.get<string>('state') ?? 'pending'
    const limit = Math.min(100, Math.max(1, Number(request.get('limit') ?? 50) || 50))

    try {
      const rows = await Activity
        .where('review_state', '=', stateFilter)
        .orderBy('anomaly_score', 'desc')
        .limit(limit)
        .get()
        .catch(() => [])

      const items = (rows as any[]).map((row) => {
        const flags = parseFlags(row?.integrity_flags)
        return {
          id: row?.id,
          userId: row?.user_id,
          activityType: row?.activity_type,
          completedAt: row?.completed_at,
          distance: row?.distance,
          duration: row?.duration,
          captureEligible: !!row?.capture_eligible,
          integrityStatus: row?.integrity_status,
          integrityReason: row?.integrity_reason,
          anomalyScore: Number(row?.anomaly_score ?? 0),
          reviewState: row?.review_state,
          // The evidence, not just the verdict. A reviewer deciding whether a
          // track is fabricated needs to see which signals fired.
          flags: flags.map(flag => ({
            kind: flag.kind ?? 'anomaly',
            code: flag.code ?? 'unknown',
            detail: flag.detail ?? '',
            conflictsWith: flag.conflictsWith ?? null,
          })),
        }
      })

      return response.json({ success: true, items, count: items.length })
    }
    catch (error) {
      return response.json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read the integrity queue',
      }, 500)
    }
  },
})

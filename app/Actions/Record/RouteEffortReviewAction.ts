// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// POST /api/route-efforts/{id}/review (admin) - accept or reject a claim.
//
// The step that makes the board worth reading. Nothing here is automatic: the
// site's claim is that a person looked at the evidence, so a decision always
// has an author (`reviewed_by`) and, when it goes against the athlete, a
// reason they can act on.
//
// The route already carries `role:admin`; the role is re-checked here because
// an action that changes what the site publicly asserts should not depend on
// a router registration staying correct.

import { Auth } from '@stacksjs/auth'
import RouteEffort from '../../Models/RouteEffort'
import User from '../../Models/User'
import UserNotification from '../../Models/UserNotification'

import { evidenceIsSufficient, STYLE_LABELS } from '../../../resources/functions/route-records'
import { isAdminUser, shapeEfforts } from '../../Support/routeEfforts'

const DECISIONS = ['verify', 'reject', 'reopen'] as const

export default new Action({
  name: 'Route Effort Review',
  description: 'Verify, reject, or reopen a record attempt',
  method: 'POST',

  async handle(request) {
    const reviewer = await Auth.user().catch(() => null)
    if (!reviewer)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!await isAdminUser(reviewer.id))
      return response.json({ success: false, error: 'Reviewer access required' }, 403)

    const effortId = positiveInt(request.get('id'))
    const decision = request.get<string>('decision')
    const note = boundedString(request.get('note') ?? request.get('review_note'), 1000)

    const fields: Record<string, string> = {}
    if (!effortId)
      fields.id = 'required: a positive integer effort id'
    if (!DECISIONS.includes(decision as typeof DECISIONS[number]))
      fields.decision = `must be one of: ${DECISIONS.join(', ')}`
    // A rejection without a reason is unappealable, and the athlete's only
    // recourse becomes guessing at a resubmission.
    if (decision === 'reject' && !note)
      fields.note = 'required: tell the athlete what would make this verifiable'

    if (Object.keys(fields).length)
      return response.json({ success: false, error: 'Validation failed', fields }, 422)

    try {
      const effort = await RouteEffort.find(effortId as number)
      if (!effort)
        return response.json({ success: false, error: 'Attempt not found' }, 404)

      // Only a finished claim is reviewable. An attempt still out there has
      // nothing to verify, and a DNF is a fact the athlete reported about
      // themselves rather than a claim on the board.
      if (decision !== 'reopen' && effort.status !== 'pending' && effort.status !== 'rejected') {
        return response.json({
          success: false,
          error: `An attempt with status "${effort.status}" is not awaiting review`,
        }, 409)
      }

      if (decision === 'verify' && !evidenceIsSufficient({
        status: 'pending',
        activityId: effort.activity_id,
        evidenceUrl: effort.evidence_url,
        gpxUrl: effort.gpx_url,
      })) {
        return response.json({
          success: false,
          error: 'This attempt has no GPS trace attached. Reject it, or ask the athlete for one, rather than verifying it unsupported by evidence.',
        }, 422)
      }

      // Reopening puts a decided claim back in the queue — the escape hatch
      // for a record that turns out to have been mis-measured, and the only
      // way a verified time is ever edited.
      const nextStatus = decision === 'verify' ? 'verified' : decision === 'reject' ? 'rejected' : 'pending'

      await RouteEffort.where('id', '=', effortId).update({
        status: nextStatus,
        reviewed_by: decision === 'reopen' ? null : reviewer.id,
        reviewed_at: decision === 'reopen' ? null : new Date().toISOString(),
        review_note: note ?? null,
      })

      const updated = await RouteEffort.find(effortId as number)
      const [shaped] = await shapeEfforts([updated])

      // Tell the athlete. A decision they have to go looking for is one they
      // will find weeks later, by which time a fixable rejection is stale.
      await notifyAthlete(shaped, reviewer, decision as typeof DECISIONS[number], note)

      return response.json({ success: true, effort: shaped })
    }
    catch (error) {
      console.error('[records] review failed:', error)
      return response.json({ success: false, error: 'Failed to record the decision' }, 500)
    }
  },
})

/** Best-effort: a notification that fails must not undo a recorded decision. */
async function notifyAthlete(
  effort: any,
  reviewer: any,
  decision: typeof DECISIONS[number],
  note: string | null,
): Promise<void> {
  try {
    const reviewerRow = await User.find(reviewer.id).catch(() => null)
    const style = STYLE_LABELS[effort.style as keyof typeof STYLE_LABELS] ?? effort.style
    const body = decision === 'verify'
      ? `Your ${style.toLowerCase()} time on ${effort.trailName} is verified — ${effort.elapsedLabel}`
      : decision === 'reject'
        ? `Your ${style.toLowerCase()} claim on ${effort.trailName} was not accepted: ${note}`
        : `Your ${style.toLowerCase()} claim on ${effort.trailName} is back under review`
    await UserNotification.forceCreate({
      recipient_id: effort.userId,
      actor_id: reviewer.id,
      actor_name: reviewerRow?.name ?? 'A reviewer',
      type: 'record',
      body,
      link: `/effort/${effort.id}`,
      read: false,
    })
  }
  catch (error) {
    console.error('[records] review notification failed:', error)
  }
}

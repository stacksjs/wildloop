// Auth is imported explicitly for the same reason as every other admin action
// here: `Auth.user()` is not in the API bundle's auto-imports.
//
// POST /api/admin/integrity-review/{id} (admin) — decide a flagged capture.
//
// A decision always has an author and, when it goes against the athlete, a
// reason they can act on. Upholding a flag strips the capture's eligibility,
// which is what makes the queue worth working: clearing and upholding both
// change something.
//
// Note what this deliberately does not do: it does not re-run the territory
// engine. Ground already taken stays taken until the next sweep recomputes it,
// because unwinding a capture retroactively would also unwind every capture
// that has since been made against it, and that is a decision for an operator
// with the whole picture rather than a side effect of one review.

import { Auth } from '@stacksjs/auth'
import Activity from '../../Models/Activity'
import UserNotification from '../../Models/UserNotification'
import { isAdminUser } from '../../Support/routeEfforts'

const DECISIONS = ['clear', 'uphold', 'reopen'] as const
type Decision = typeof DECISIONS[number]

export default new Action({
  name: 'Integrity Review',
  description: 'Clear or uphold a flagged capture',
  method: 'POST',

  async handle(request) {
    const reviewer = await Auth.user().catch(() => null)
    if (!reviewer)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!await isAdminUser(reviewer.id))
      return response.json({ success: false, error: 'Reviewer access required' }, 403)

    const activityId = Number(request.get('id'))
    const decision = request.get<string>('decision') as Decision
    const rawNote = request.get<string>('note')
    const note = typeof rawNote === 'string' ? rawNote.slice(0, 1000).trim() : ''

    const fields: Record<string, string> = {}
    if (!Number.isInteger(activityId) || activityId <= 0)
      fields.id = 'required: a positive integer activity id'
    if (!DECISIONS.includes(decision))
      fields.decision = `must be one of: ${DECISIONS.join(', ')}`
    // An athlete told their run was rejected with no reason has no recourse
    // but to guess, and will guess that the app is broken.
    if (decision === 'uphold' && !note)
      fields.note = 'required: tell the athlete what was wrong with the recording'

    if (Object.keys(fields).length)
      return response.json({ success: false, error: 'Validation failed', fields }, 422)

    try {
      const activity = await Activity.find(activityId)
      if (!activity)
        return response.json({ success: false, error: 'Activity not found' }, 404)

      const updates: Record<string, unknown> = {
        review_state: decision === 'clear' ? 'cleared' : decision === 'uphold' ? 'upheld' : 'pending',
      }

      if (decision === 'uphold') {
        updates.capture_eligible = false
        updates.integrity_status = 'rejected'
        updates.integrity_reason = note
      }
      else if (decision === 'clear') {
        // Clearing does not re-grant eligibility it never had: a capture
        // refused by the physics checks is not made legitimate by a reviewer
        // deciding the statistics were innocent.
        updates.integrity_reason = (activity as any).capture_eligible ? null : (activity as any).integrity_reason
      }

      await Activity.where('id', '=', activityId).update(updates as any)

      const athleteId = Number((activity as any).user_id)
      if (decision === 'uphold' && Number.isFinite(athleteId)) {
        await UserNotification.forceCreate({
          recipient_id: athleteId,
          // The reviewer is the actor, so the athlete can see a decision was
          // made by a person rather than appearing from the system.
          actor_id: reviewer.id,
          actor_name: (reviewer as any)?.name ?? 'A reviewer',
          type: 'integrity_review',
          body: `A recorded activity was reviewed and will not count for territory: ${note}`,
          link: `/activity/${activityId}`,
          read: false,
        } as any).catch(() => null)
      }

      return response.json({
        success: true,
        activityId,
        reviewState: updates.review_state,
        reviewedBy: reviewer.id,
      })
    }
    catch (error) {
      return response.json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to record the review',
      }, 500)
    }
  },
})

// Auth is imported explicitly for the same reason as every other admin action
// here: `Auth.user()` is not in the API bundle's auto-imports.
//
// POST /api/admin/trail-photos/{id}/review (admin) — approve, reject or
// reopen one photo candidate.
//
// Approving is the only way a Commons photograph becomes a trail's cover, and
// it carries the reviewer's id. The licence is checked again here whatever
// the queue showed: a click cannot make a non-commercial photo usable.

import { Auth } from '@stacksjs/auth'
import { isAdminUser } from '../../Support/routeEfforts'
import { decidePhotoCandidate, DECISIONS, isPhotoDecision } from '../../Support/trailPhotoReview'

export default new Action({
  name: 'Trail Photo Review',
  description: 'Approve, reject or reopen a trail photo candidate',
  method: 'POST',

  async handle(request) {
    const reviewer = await Auth.user().catch(() => null)
    if (!reviewer)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!await isAdminUser(reviewer.id))
      return response.json({ success: false, error: 'Reviewer access required' }, 403)

    const candidateId = positiveInt(request.get('id'))
    const decision = request.get('decision')
    const note = boundedString(request.get('note'), 500)

    if (!candidateId || !isPhotoDecision(decision)) {
      const fields: Record<string, string> = {}
      if (!candidateId)
        fields.id = 'required: a positive integer candidate id'
      if (!isPhotoDecision(decision))
        fields.decision = `must be one of: ${DECISIONS.join(', ')}`
      return response.json({ success: false, error: 'Validation failed', fields }, 422)
    }

    try {
      const result = await decidePhotoCandidate(candidateId, decision, Number(reviewer.id), { note: note || undefined })
      if (!result.ok)
        return response.json({ success: false, error: result.error }, result.status)
      return response.json({ success: true, id: result.id, trailId: result.trailId, status: result.status, reviewedBy: reviewer.id })
    }
    catch (error) {
      return response.json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to record the decision',
      }, 500)
    }
  },
})

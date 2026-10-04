// Auth is imported explicitly for the same reason as every other admin action
// here: `Auth.user()` is not in the API bundle's auto-imports.
//
// GET /api/admin/trail-photos (admin) — Commons photographs waiting for a
// person to say whether they show the trail (#1006).
//
// The nightly `trails:source-photos` fills this; /admin/photos reads it. Most
// wanted trails first, each with its line, so the reviewer can hold a photo
// against where the trail actually runs.

import { Auth } from '@stacksjs/auth'
import { isAdminUser } from '../../Support/routeEfforts'
import { pendingPhotoQueue } from '../../Support/trailPhotoReview'

export default new Action({
  name: 'Trail Photo Queue',
  description: 'Photo candidates waiting for review, most wanted trails first',
  method: 'GET',

  async handle(request) {
    const reviewer = await Auth.user().catch(() => null)
    if (!reviewer)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    // Re-checked here rather than trusted from the route, like the other
    // review queues: what this approves is shown on every card.
    if (!await isAdminUser(reviewer.id))
      return response.json({ success: false, error: 'Reviewer access required' }, 403)

    try {
      const page = await pendingPhotoQueue({ limit: Number(request.get('limit') ?? 20) || 20 })
      return response.json({ success: true, ...page })
    }
    catch (error) {
      return response.json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to read the photo queue',
      }, 500)
    }
  },
})

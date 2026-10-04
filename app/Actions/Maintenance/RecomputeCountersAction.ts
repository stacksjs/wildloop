// POST /api/maintenance/recompute-counters (admin) - recomputes every
// denormalized counter from its source-of-truth rows (#973):
//   activities.kudos_count   ← kudos
//   trails.rating            ← avg(trail_reviews.rating), 1 decimal
//   trails.review_count      ← count(trail_reviews)
//   territory_stats holdings ← the territories each player holds
// The work lives in app/Support/counterRepair.ts, shared with
// `buddy counters:recompute`, which runs it nightly.

import { repairCounters } from '../../Support/counterRepair'

export default new Action({
  name: 'Recompute Counters',
  description: 'Recompute denormalized counters (kudos, trail ratings, territory holdings)',
  method: 'POST',

  async handle() {
    try {
      const result = await repairCounters()
      return response.json({ success: true, ...result })
    }
    catch (error) {
      console.error('Error recomputing counters:', error)
      return response.json({ success: false, error: 'Failed to recompute counters' }, 500)
    }
  },
})

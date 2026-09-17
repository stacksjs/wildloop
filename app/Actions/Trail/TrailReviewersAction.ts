// Recent reviewers for a page of trail cards. Public and read-only.
//
// Separate from GET /api/trails on purpose: that query counts its matches and
// returns geometry for every row, and this is a decoration that can arrive a
// moment after the list does. See app/Support/trailReviewers for the SQL.

import { db } from '@stacksjs/orm'
import {
  buildReviewerSummaries,
  readTrailIds,
  recentCutoff,
  recentReviewersSql,
  RECENT_WINDOW_DAYS,
  type ReviewerRow,
} from '../../Support/trailReviewers'

export default new Action({
  name: 'Trail Reviewers',
  description: 'Recent reviewers and recent review counts for a set of trails',
  method: 'GET',

  async handle(request) {
    const ids = readTrailIds(request.get('ids'))

    if (ids.length === 0)
      return response.json({ success: true, windowDays: RECENT_WINDOW_DAYS, trails: {} })

    try {
      const rows = await db.sql`${db.unsafe(recentReviewersSql(ids, recentCutoff()))}`.execute() as ReviewerRow[]

      return response.json({
        success: true,
        windowDays: RECENT_WINDOW_DAYS,
        trails: buildReviewerSummaries(rows ?? []),
      })
    }
    catch (error) {
      // A card without faces is a card; a catalog page that fails because its
      // decoration did is not. Answer empty and let the list stand.
      console.error('[trails] reviewers failed:', error)
      return response.json({ success: false, windowDays: RECENT_WINDOW_DAYS, trails: {} }, 500)
    }
  },
})

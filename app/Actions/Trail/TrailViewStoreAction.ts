import { countTrailView, judgeView, recentTrailViews } from '../../Support/trailViews'

/**
 * POST /api/trails/{id}/view — somebody opened this trail page.
 *
 * Sent once by the trail page after it mounts. Whether it counts, and why
 * the page view is counted here rather than where the page or the trail is
 * served, is in app/Support/trailViews.ts.
 *
 * Answers at once with what was decided. The count is written after the
 * response, and a write that fails is logged and forgotten: a view is not
 * worth a slow page or an error.
 */
export default new Action({
  name: 'Trail View Store',
  description: 'Count one view of a trail page toward its popularity',
  method: 'POST',

  // A view carries no authority to protect, and the first page of a first
  // visit has no CSRF cookie yet. Another site sending one is refused by the
  // browser-reported origin instead (`isCrossSite`).
  skipCsrf: true,

  async handle(request) {
    const trailId = positiveInt(request.get('id'))
    if (!trailId)
      return response.json({ success: false, error: 'Trail ID is required' }, 422)

    const verdict = judgeView(request, trailId, recentTrailViews)
    if (verdict.counted)
      void countTrailView(trailId)

    return response.json({ success: true, ...verdict }, 202)
  },
})

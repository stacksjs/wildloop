import { summarizeDifficulty } from '../../Support/reviewDifficulty'
import { cachedReviews, cacheReviews, REVIEW_CACHE_TTL_MS } from '../../Support/reviewCache'

/**
 * Reviews carry the trail's condition reports and change only when someone
 * reviews it, so they are kept 15 minutes here and in the browser. Private:
 * the server forgets a trail the moment a review is written, and a shared
 * cache in front of it would not.
 */
function cachedJson(body: unknown, hit: boolean): Response {
  return new Response(JSON.stringify(body), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `private, max-age=${REVIEW_CACHE_TTL_MS / 1000}`,
      'X-Cache': hit ? 'HIT' : 'MISS',
    },
  })
}

//
// GET /api/trails/{id}/reviews - a trail's reviews with author names joined
// (#981). Public read; the trail detail Reviews tab renders straight from
// this (newest first).

export default new Action({
  name: 'Trail Review Index',
  description: 'List a trail\'s reviews with author names',
  method: 'GET',

  async handle(request) {
    const trailId = positiveInt(request.get('id') ?? request.get('trail_id'))
    if (!trailId)
      return response.json({ success: false, error: 'Validation failed', fields: { trail_id: 'required: a positive integer trail id' } }, 422)

    const pageKey = `${request.get('limit') ?? ''}:${request.get('offset') ?? ''}`
    const cached = cachedReviews(trailId, pageKey)
    if (cached !== undefined)
      return cachedJson(cached, true)

    try {
      const rows = (await Review
        .where('trail_id', '=', trailId)
        .orderBy('created_at', 'desc')
        .get()) ?? []

      const userIds = [...new Set(rows.map((r: any) => r.user_id).filter(Boolean))]
      const users = userIds.length ? await User.whereIn('id', userIds).get() : []
      const userName = new Map(users.map((u: any) => [u.id, u.name]))

      const reviews = rows.map((r: any) => ({
        id: r.id,
        userId: r.user_id,
        userName: userName.get(r.user_id) ?? 'Unknown',
        rating: r.rating ?? 0,
        title: r.title,
        content: r.content,
        conditions: r.conditions,
        difficulty: r.difficulty ?? null,
        // Passed through as stored. The column has held JSON arrays, comma
        // separated lists and single URLs, and the client parses all three —
        // re-encoding one of those shapes here would only add a fourth.
        photos: r.photos ?? null,
        visitDate: r.visit_date,
        createdAt: r.created_at,
      }))

      // Generous default - the reviews tab renders the full set, no load-more
      // (#978 review); ?limit/?offset still paginate on demand.
      const paged = paginate(reviews, readPageParams(request, { defaultLimit: 200, maxLimit: 200 }))
      // Tallied over every review, not the page: it describes the trail.
      const difficulty = summarizeDifficulty(rows.map((r: any) => r.difficulty))
      const body = { success: true, reviews: paged.items, difficulty, meta: paged.meta }
      cacheReviews(trailId, pageKey, body)
      return cachedJson(body, false)
    }
    catch (error) {
      console.error('[trail-reviews] index failed:', error)
      return response.json({ success: false, error: 'Failed to fetch reviews' }, 500)
    }
  },
})

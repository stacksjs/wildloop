// No imports needed - everything is auto-imported!
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
      return response.json({ success: true, reviews: paged.items, meta: paged.meta })
    }
    catch (error) {
      console.error('[trail-reviews] index failed:', error)
      return response.json({ success: false, error: 'Failed to fetch reviews' }, 500)
    }
  },
})

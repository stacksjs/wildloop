// No imports needed - everything is auto-imported!
//
// GET /api/users/{id}/saved-trails - a user's saved trails with the trail
// summary joined in (#969). Public read, like follows/achievements; the
// profile's Saved tab renders straight from this.

export default new Action({
  name: 'Saved Trail Index',
  description: 'List a user\'s saved trails with trail summaries',
  method: 'GET',

  async handle(request) {
    const userId = positiveInt(request.get('id') ?? request.get('user_id'))
    if (!userId)
      return response.json({ success: false, error: 'Validation failed', fields: { user_id: 'required: a positive integer user id' } }, 422)

    try {
      const rows = (await SavedTrail
        .where('user_id', '=', userId)
        .orderBy('created_at', 'desc')
        .get()) ?? []

      const trailIds = [...new Set(rows.map((r: any) => r.trail_id).filter(Boolean))]
      const trails = trailIds.length ? await Trail.whereIn('id', trailIds).get() : []
      const trailById = new Map(trails.map((t: any) => [t.id, t]))

      // Only the hearts: a row can be a trail marked done and not saved.
      const savedTrails = rows
        .filter((r: any) => trailById.has(r.trail_id) && Number(r.is_saved ?? 1) !== 0)
        .map((r: any) => {
          const t = trailById.get(r.trail_id)
          return {
            id: r.id,
            trailId: r.trail_id,
            notes: r.notes,
            wantToVisit: !!r.want_to_visit,
            hasVisited: !!r.has_visited,
            savedAt: r.created_at,
            trail: {
              id: t.id,
              name: t.name,
              location: t.location,
              difficulty: t.difficulty,
              distance: t.distance,
              elevation: t.elevation,
              rating: t.rating,
              reviewCount: t.review_count ?? 0,
              // The card's thumbnail, the same cover the catalog shows.
              image: t.image ?? null,
            },
          }
        })

      // Generous default - the profile Saved tab renders the full set, no
      // load-more (#978 review); ?limit/?offset still paginate on demand.
      const paged = paginate(savedTrails, readPageParams(request, { defaultLimit: 200, maxLimit: 200 }))
      return response.json({ success: true, savedTrails: paged.items, meta: paged.meta })
    }
    catch (error) {
      console.error('[saved-trails] index failed:', error)
      return response.json({ success: false, error: 'Failed to fetch saved trails' }, 500)
    }
  },
})

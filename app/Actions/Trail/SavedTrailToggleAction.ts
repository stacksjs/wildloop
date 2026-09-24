// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// POST /api/trails/{id}/save - toggle the session user's saved/bookmarked
// state for a trail (#969). Idempotent: save if absent, unsave if present;
// the (user_id, trail_id) unique index (#972) makes a concurrent double-tap
// resolve to "already saved" instead of a duplicate row.

import { Auth } from '@stacksjs/auth'
import { wantsIt } from '../../Support/toggleIntent'

export default new Action({
  name: 'Saved Trail Toggle',
  description: 'Save or unsave a trail for the acting user',
  method: 'POST',

  async handle(request) {
    const trailId = positiveInt(request.get('id') ?? request.get('trail_id'))
    // Saver from the authenticated session (route is behind `auth`); body
    // fallback is for the in-process harness only.
    const userId = (await Auth.user().catch(() => null))?.id

    // Field validation (#977).
    if (!userId)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!trailId)
      return response.json({ success: false, error: 'Validation failed', fields: { trail_id: 'required: a positive integer trail id' } }, 422)

    try {
      const trail = await Trail.find(trailId)
      if (!trail)
        return response.json({ success: false, error: 'Trail not found' }, 404)

      const existing = await SavedTrail
        .where('user_id', '=', userId)
        .where('trail_id', '=', trailId)
        .first()

      // A row can be done without being saved (see TrailDoneToggleAction);
      // only is_saved is the heart.
      const isSaved = Boolean(existing) && Number((existing as any).is_saved ?? 1) !== 0
      const saved = wantsIt(request.method, isSaved)
      if (!saved) {
        // Unsaving a trail they have done keeps the done.
        if (existing && (existing as any).has_visited)
          await SavedTrail.where('id', '=', existing.id).update({ is_saved: false })
        else if (existing)
          await SavedTrail.delete(existing.id)
      }
      else if (existing) {
        if (!isSaved)
          await SavedTrail.where('id', '=', existing.id).update({ is_saved: true })
      }
      else {
        try {
          await SavedTrail.forceCreate({
            user_id: userId,
            trail_id: trailId,
            notes: null,
            want_to_visit: true,
            has_visited: false,
            is_saved: true,
          })
        }
        catch (err) {
          // Concurrent double-tap raced the existence check; the unique
          // index (#972) kept one row - the trail is saved either way.
          if (!String(err).includes('UNIQUE constraint failed'))
            throw err
        }
      }

      return response.json({ success: true, saved })
    }
    catch (error) {
      console.error('Error toggling saved trail:', error)
      return response.json({ success: false, error: 'Failed to toggle saved trail' }, 500)
    }
  },
})

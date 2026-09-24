// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports
// (see SavedTrailToggleAction). Everything else is auto-imported.
//
// PUT /api/trails/{id}/done - mark a trail as done; DELETE - take the mark
// back. For a trail walked before Wildloop, or recorded without picking the
// trail: activities on a trail count as done on their own, and this mark
// does not touch them.
//
// It lives on the saved_trails row (has_visited). Marking an unsaved trail
// creates a row that is done and not saved (is_saved false), so the heart
// stays off; taking the mark back from such a row removes it.

import { Auth } from '@stacksjs/auth'
import { wantsIt } from '../../Support/toggleIntent'

export default new Action({
  name: 'Trail Done Toggle',
  description: 'Mark or unmark a trail as done for the acting user',
  method: 'PUT',

  async handle(request) {
    const trailId = positiveInt(request.get('id') ?? request.get('trail_id'))
    const userId = (await Auth.user().catch(() => null))?.id

    if (!userId)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!trailId)
      return response.json({ success: false, error: 'Validation failed', fields: { trail_id: 'required: a positive integer trail id' } }, 422)

    try {
      const trail = await Trail.find(trailId)
      if (!trail)
        return response.json({ success: false, error: 'Trail not found' }, 404)

      const existing: any = await SavedTrail
        .where('user_id', '=', userId)
        .where('trail_id', '=', trailId)
        .first()

      const done = wantsIt(request.method, Boolean(existing?.has_visited))
      const isSaved = Boolean(existing) && Number(existing.is_saved ?? 1) !== 0

      if (done) {
        if (existing)
          await SavedTrail.where('id', '=', existing.id).update({ has_visited: true, want_to_visit: false })
        else {
          try {
            await SavedTrail.forceCreate({
              user_id: userId,
              trail_id: trailId,
              notes: null,
              want_to_visit: false,
              has_visited: true,
              is_saved: false,
            })
          }
          catch (err) {
            // A double tap raced the existence check; the unique index kept
            // one row, and it is done either way.
            if (!String(err).includes('UNIQUE constraint failed'))
              throw err
          }
        }
      }
      else if (existing) {
        if (isSaved)
          await SavedTrail.where('id', '=', existing.id).update({ has_visited: false, want_to_visit: true })
        else
          await SavedTrail.delete(existing.id)
      }

      return response.json({ success: true, done })
    }
    catch (error) {
      console.error('Error toggling trail done:', error)
      return response.json({ success: false, error: 'Failed to update the trail' }, 500)
    }
  },
})

import { Action } from '@stacksjs/actions'
import { Auth } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import Review from '../../Models/Review'
import SavedTrail from '../../Models/SavedTrail'
import Trail from '../../Models/Trail'
import { positiveInt } from '../../../resources/functions/validate'
import { avatarOf } from '../../Support/avatars'
import { trailReviewPayload } from '../../Support/trailReviewPayload'

/** A trail's personal state must never depend on a page of community results. */
export default new Action({
  name: 'Trail Viewer State',
  description: 'Read the signed-in athlete saved state and review for one trail',
  method: 'GET',
  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    const trailId = positiveInt(request.getParam('id'))
    if (!trailId)
      return response.json({ success: false, error: 'A positive trail ID is required' }, 422)
    try {
      if (!await Trail.find(trailId))
        return response.json({ success: false, error: 'Trail not found' }, 404)
      const [saved, review] = await Promise.all([
        SavedTrail.where('trail_id', '=', trailId).where('user_id', '=', user.id).first(),
        Review.where('trail_id', '=', trailId).where('user_id', '=', user.id).first(),
      ])
      return new Response(JSON.stringify({
        success: true,
        userId: user.id,
        saved: Boolean(saved) && Number(saved?.is_saved ?? 1) !== 0,
        review: review ? trailReviewPayload(review, {name:user.name,avatar:avatarOf(user)}) : null,
      }), {headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'private, no-store'}})
    }
    catch (error) {
      console.error('[trail-viewer] read failed:', error)
      return response.json({ success: false, error: 'Your trail state could not be loaded. Please try again.' }, 500)
    }
  },
})

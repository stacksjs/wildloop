import { Action } from '@stacksjs/actions'
import { Auth } from '@stacksjs/auth'
import { response } from '@stacksjs/router'
import Review from '../../Models/Review'
import { positiveInt } from '../../../resources/functions/validate'
import { invalidateTrailReviews } from '../../Support/reviewCache'
import { rebuildTrailReviewRating } from '../../Support/trailReviewRating'

/** One review per person per trail: the session identifies the review to remove. */
export default new Action({
  name: 'Trail Review Destroy',
  description: 'Delete the signed-in athlete review of a trail',
  method: 'DELETE',
  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    const trailId = positiveInt(request.getParam('id'))
    if (!trailId)
      return response.json({ success: false, error: 'A positive trail ID is required' }, 422)
    try {
      const review = await Review.where('trail_id', '=', trailId).where('user_id', '=', user.id).first()
      if (!review)
        return response.json({ success: false, error: 'Review not found' }, 404)
      await Review.where('id', '=', review.id).where('user_id', '=', user.id).delete()
      invalidateTrailReviews(trailId)
      const trail = await rebuildTrailReviewRating(trailId)
      return response.json({ success: true, deleted: review.id, trail })
    }
    catch (error) {
      console.error('[trail-reviews] destroy failed:', error)
      return response.json({ success: false, error: 'Could not delete your review. Please try again.' }, 500)
    }
  },
})

// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// POST /api/trails/{id}/reviews (auth) - create or update the session user's
// review of a trail. One review per user per trail (#972 unique index); a
// second submission updates the existing review instead of duplicating it.
// After every write the trail's denormalized rating/review_count are
// recomputed from the review rows (#973), so they can never drift.

import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { isReviewDifficulty, REVIEW_DIFFICULTIES } from '../../Support/reviewDifficulty'
import { trailPhotoUrl } from '../../Support/trailPhotoPayload'
import { invalidateTrailReviews } from '../../Support/reviewCache'
import { conditionReportedAt, VISIT_DATE_MESSAGE, visitDateProblem } from '../../Support/reviewConditions'

import { TRAIL_CONDITION_IDS } from '../../../resources/functions/trail-conditions'
import { avatarOf } from '../../Support/avatars'

// The one list the form offers and the database's CHECK allows (#166).
const REVIEW_CONDITIONS = TRAIL_CONDITION_IDS

/** Photos attached to one review; the trail gallery caps what it shows anyway. */
const MAX_REVIEW_PHOTOS = 10
const PHOTO_ID = /^[0-9a-f-]{8,64}$/i

export default new Action({
  name: 'Trail Review Store',
  description: 'Create or update the acting user\'s review of a trail',
  method: 'POST',

  async handle(request) {
    const trailId = positiveInt(request.get('id') ?? request.get('trail_id'))
    // Reviewer from the authenticated session (route is behind `auth`); body
    // fallback is for the in-process seed harness only.
    const userId = (await Auth.user().catch(() => null))?.id
    const rating = request.get<number>('rating')
    const content = (request.get<string>('content') ?? '').trim()
    const title = (request.get<string>('title') ?? '').trim() || null
    const conditions = request.get<string>('conditions') ?? null
    const visitDate = request.get<string>('visit_date') ?? null
    const difficulty = request.get<string>('difficulty') ?? null
    // Absent means "leave the photos as they are" on an update; an empty list
    // means "remove them".
    const photoIds = request.get<unknown>('photo_ids')

    if (!userId)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    // Field validation (#977).
    const fields: Record<string, string> = {}
    if (!trailId)
      fields.trail_id = 'required: a positive integer trail id'
    if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5)
      fields.rating = 'required: an integer from 1 to 5'
    if (content.length < 10 || content.length > 2000)
      fields.content = 'required: 10-2000 characters'
    if (conditions !== null && !REVIEW_CONDITIONS.includes(conditions))
      fields.conditions = `must be one of: ${REVIEW_CONDITIONS.join(', ')}`
    if (difficulty !== null && !isReviewDifficulty(difficulty))
      fields.difficulty = `must be one of: ${REVIEW_DIFFICULTIES.join(', ')}`
    // A visit date decides when a condition was seen, so an unchecked one is
    // not a cosmetic field: a date in the future outranks every real report,
    // keeping a hazard on the page or clearing one that is still there.
    if (visitDate !== null && visitDateProblem(visitDate))
      fields.visit_date = VISIT_DATE_MESSAGE
    if (photoIds !== undefined && photoIds !== null
      && (!Array.isArray(photoIds) || photoIds.length > MAX_REVIEW_PHOTOS || photoIds.some(id => typeof id !== 'string' || !PHOTO_ID.test(id))))
      fields.photo_ids = `must be a list of up to ${MAX_REVIEW_PHOTOS} photo ids`
    if (Object.keys(fields).length)
      return response.json({ success: false, error: 'Validation failed', fields }, 422)

    try {
      const trail = await Trail.find(trailId)
      if (!trail)
        return response.json({ success: false, error: 'Trail not found' }, 404)

      // Only photos this reviewer uploaded to this trail can be attached. The
      // column is rendered straight into <img src>, so it never stores a URL
      // a client typed in: it stores the URLs of rows we just looked up.
      let photos: string | null | undefined
      if (Array.isArray(photoIds)) {
        const ids = [...new Set(photoIds as string[])]
        if (ids.length) {
          // At most 30 per person per trail (TrailPhotoStoreAction), so read
          // them all and check membership here.
          const owned = await db.sql`
            SELECT uuid FROM trail_photos WHERE trail_id = ${trailId} AND user_id = ${userId}
          `.execute() as Array<{ uuid: string }>
          const ownedIds = new Set(owned.map(row => row.uuid))
          if (ids.some(id => !ownedIds.has(id)))
            return response.json({ success: false, error: 'Validation failed', fields: { photo_ids: 'can only attach photos you uploaded to this trail' } }, 422)
        }
        photos = ids.length ? JSON.stringify(ids.map(id => trailPhotoUrl(trailId, id))) : null
      }

      const now = new Date().toISOString()
      const fields: Record<string, unknown> = {
        rating,
        title,
        content,
        conditions,
        difficulty,
        visit_date: visitDate,
      }
      if (photos !== undefined)
        fields.photos = photos

      /** When the condition being saved was seen — see reviewConditions.ts. */
      const reportedAt = (previous: any): string | null => conditionReportedAt(
        previous ? { conditions: previous.conditions ?? null, conditionsReportedAt: previous.conditions_reported_at ?? null } : null,
        conditions,
        visitDate,
        now,
      )

      let reviewId: number
      let updated = false
      const existing = await Review
        .where('user_id', '=', userId)
        .where('trail_id', '=', trailId)
        .first()
      if (existing) {
        await Review.forceUpdate(existing.id, { ...fields, conditions_reported_at: reportedAt(existing) })
        reviewId = existing.id
        updated = true
      }
      else {
        try {
          const created = await Review.forceCreate({
            user_id: userId,
            trail_id: trailId,
            photos: null,
            ...fields,
            conditions_reported_at: reportedAt(null),
            helpful_count: 0,
          })
          reviewId = created.id
        }
        catch (err) {
          // Concurrent double-submit: the unique index (#972) rejected the
          // second insert - update the row the winner created.
          if (!String(err).includes('UNIQUE constraint failed'))
            throw err
          const winner = await Review
            .where('user_id', '=', userId)
            .where('trail_id', '=', trailId)
            .first()
          if (!winner)
            throw err
          await Review.forceUpdate(winner.id, { ...fields, conditions_reported_at: reportedAt(winner) })
          reviewId = winner.id
          updated = true
        }
      }

      // The review is written: the cached reviews (and condition reports) for
      // this trail are stale, before anything below can fail.
      invalidateTrailReviews(trailId)

      // After-write hook (#973): rebuild this trail's aggregates from rows.
      const trailReviews = (await Review.where('trail_id', '=', trailId).get()) ?? []
      const reviewCount = trailReviews.length
      const avgRating = reviewCount
        ? Math.round(trailReviews.reduce((sum: number, r: any) => sum + (r.rating ?? 0), 0) / reviewCount * 10) / 10
        : 0
      await Trail.forceUpdate(trailId, { rating: avgRating, review_count: reviewCount })

      const user = await User.find(userId)
      return response.json({
        success: true,
        updated,
        review: {
          id: reviewId,
          userId,
          userName: user?.name ?? 'Unknown',
          userAvatar: avatarOf(user),
          trailId,
          rating,
          title,
          content,
          conditions,
          difficulty,
          photos: photos ?? (existing?.photos ?? null),
          visitDate,
          conditionsReportedAt: reportedAt(existing ?? null),
        },
        trail: { id: trailId, rating: avgRating, reviewCount },
      }, updated ? 200 : 201)
    }
    catch (error) {
      console.error('[trails] review store failed:', error)
      return response.json({ success: false, error: 'Failed to save review' }, 500)
    }
  },
})

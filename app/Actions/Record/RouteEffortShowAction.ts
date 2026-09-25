// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// GET /api/route-efforts/{id} - one attempt in full, with its trip report.
//
// This is the page a record links to from anywhere else in the app, so it
// also carries the context that makes the time mean something: where it sits
// on the route's board, and what it displaced.

import { Auth } from '@stacksjs/auth'
import RouteEffort from '../../Models/RouteEffort'

import { isHeadlineRecord, rankBucket, recordBucketKey } from '../../../resources/functions/route-records'
import { canSeePrivateEffort, isAdminUser, PUBLIC_STATUSES, shapeEfforts } from '../../Support/routeEfforts'

export default new Action({
  name: 'Route Effort Show',
  description: 'One record attempt, its trip report, and where it ranks',
  method: 'GET',

  async handle(request) {
    const effortId = positiveInt(request.get('id'))
    if (!effortId)
      return response.json({ success: false, error: 'Validation failed', fields: { id: 'required: a positive integer effort id' } }, 422)

    try {
      const row = await RouteEffort.find(effortId)
      if (!row)
        return response.json({ success: false, error: 'Attempt not found' }, 404)

      const viewerId = (await Auth.user().catch(() => null))?.id ?? null
      const isAdmin = await isAdminUser(viewerId)
      const privileged = canSeePrivateEffort(row, viewerId, isAdmin)
      if (!PUBLIC_STATUSES.includes(row.status) && !privileged)
        return response.json({ success: false, error: 'Attempt not found' }, 404)

      const siblings = await shapeEfforts((await RouteEffort.where('trail_id', '=', row.trail_id).get()) ?? [])
      const [effort] = await shapeEfforts([row])

      const bucketKey = recordBucketKey(effort)
      const bucket = rankBucket(siblings.filter(other => recordBucketKey(other) === bucketKey))
      const placed = bucket.find(entry => entry.id === effort.id)

      return response.json({
        success: true,
        effort: {
          ...effort,
          // The review note explains a rejection to the person who has to fix
          // it; it is not commentary for strangers to read.
          reviewNote: privileged ? effort.reviewNote : null,
          rank: placed?.rank ?? null,
          bucketSize: bucket.length,
          headline: isHeadlineRecord(effort, siblings),
          isOwner: viewerId !== null && row.user_id === viewerId,
          canReview: isAdmin,
        },
      })
    }
    catch (error) {
      console.error('[records] show failed:', error)
      return response.json({ success: false, error: 'Failed to fetch the attempt' }, 500)
    }
  },
})

// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// DELETE /api/route-efforts/{id} (auth) - withdraw your own claim.
//
// Withdrawing is for a claim that should never have been filed: the wrong
// route, a duplicate, an attempt announced and then abandoned before the
// start. It is NOT how a failed attempt is recorded — that is a DNF, which
// stays on the athlete's history, because a records board that only shows
// successes misrepresents how often routes are attempted.
//
// A verified record cannot be withdrawn by its holder: it is the site's
// published statement and other people's rankings sit on top of it.

import { Auth } from '@stacksjs/auth'
import RouteEffort from '../../Models/RouteEffort'

import { isAdminUser } from '../../Support/routeEfforts'

export default new Action({
  name: 'Route Effort Destroy',
  description: 'Withdraw your own unverified record attempt',
  method: 'DELETE',

  async handle(request) {
    const userId = (await Auth.user().catch(() => null))?.id
    if (!userId)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const effortId = positiveInt(request.get('id'))
    if (!effortId)
      return response.json({ success: false, error: 'Validation failed', fields: { id: 'required: a positive integer effort id' } }, 422)

    try {
      const effort = await RouteEffort.find(effortId)
      if (!effort)
        return response.json({ success: false, error: 'Attempt not found' }, 404)

      const isAdmin = await isAdminUser(userId)
      if (effort.user_id !== userId && !isAdmin)
        return response.json({ success: false, error: 'That attempt belongs to another athlete' }, 403)

      if (effort.status === 'verified' && !isAdmin) {
        return response.json({
          success: false,
          error: 'A verified record cannot be withdrawn. Ask a reviewer to reopen it if it should not stand.',
        }, 409)
      }

      await RouteEffort.where('id', '=', effortId).delete()
      return response.json({ success: true, deleted: effortId })
    }
    catch (error) {
      console.error('[records] destroy failed:', error)
      return response.json({ success: false, error: 'Failed to withdraw the attempt' }, 500)
    }
  },
})

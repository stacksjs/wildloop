// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// POST /api/users/{id}/follow - the authenticated user follows/unfollows user
// {id} (idempotent toggle). The follower is the session user (#939), never the
// body, so you can't make someone else follow on their behalf.

import { Auth } from '@stacksjs/auth'
import { wantsIt } from '../../Support/toggleIntent'

export default new Action({
  name: 'Follow Toggle',
  description: 'Follow or unfollow a user',
  method: 'POST',

  async handle(request) {
    const targetId = positiveInt(request.get('id'))
    const followerId = (await Auth.user().catch(() => null))?.id

    // Field validation (#977).
    if (!targetId)
      return response.json({ success: false, error: 'Validation failed', fields: { id: 'required: a positive integer user id' } }, 422)
    if (!followerId)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (targetId === followerId)
      return response.json({ success: false, error: 'You cannot follow yourself' }, 400)

    try {
      const target = await User.find(targetId)
      if (!target)
        return response.json({ success: false, error: 'User not found' }, 404)
      if ((await blockedUserIdsFor(followerId)).has(targetId))
        return response.json({ success: false, error: 'This athlete is unavailable' }, 403)

      const existing = await Follow
        .where('follower_id', '=', followerId)
        .where('following_id', '=', targetId)
        .first()

      const following = wantsIt(request.method, Boolean(existing))
      if (!following) {
        if (existing)
          await Follow.delete(existing.id)
      }
      else if (!existing) {
        try {
          await Follow.forceCreate({ follower_id: followerId, following_id: targetId })
          // Notify the followed athlete.
          const follower = await User.find(followerId)
          await UserNotification.forceCreate({
            recipient_id: targetId,
            actor_id: followerId,
            actor_name: follower?.name ?? 'Someone',
            type: 'follow',
            body: `${follower?.name ?? 'Someone'} started following you`,
            link: `/athlete/${followerId}`,
            read: false,
          })
        }
        catch (err) {
          // A concurrent double-tap can race the existence check above; the
          // unique index (#972) rejects the second insert - the follow already
          // exists, so the toggle result stands (and the winner notified).
          if (!String(err).includes('UNIQUE constraint failed'))
            throw err
        }
      }

      const followers = await Follow.where('following_id', '=', targetId).get()
      return response.json({
        success: true,
        following,
        followerCount: (followers ?? []).length,
      })
    }
    catch (error) {
      console.error('Error toggling follow:', error)
      return response.json({ success: false, error: 'Failed to toggle follow' }, 500)
    }
  },
})

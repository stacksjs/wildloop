// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// POST /api/activities/{id}/comments - add a comment to an activity. The author
// is taken from the body for now (auth hardening tracked in #939).

import { Auth } from '@stacksjs/auth'
import { avatarOf } from '../../Support/avatars'

export default new Action({
  name: 'Activity Comment Store',
  description: 'Add a comment to an activity',
  method: 'POST',

  async handle(request) {
    const activityId = positiveInt(request.get('id') ?? request.get('activity_id'))
    // Author from the authenticated session (route is behind `auth`); body
    // fallback is for the in-process harness only.
    const userId = (await Auth.user().catch(() => null))?.id
    const body = boundedString(request.get('body'), 2000)

    // Field validation (#977).
    const fields: Record<string, string> = {}
    if (!activityId)
      fields.activity_id = 'required: a positive integer activity id'
    if (!userId)
      fields.user_id = 'required: authenticated session (or user_id in the harness)'
    if (!body)
      fields.body = 'required: comment text, at most 2000 characters'
    if (Object.keys(fields).length)
      return response.json({ success: false, error: 'Validation failed', fields }, 422)

    try {
      const activity = await Activity.find(activityId)
      if (!activity)
        return response.json({ success: false, error: 'Activity not found' }, 404)
      const following = new Set(((await Follow.where('follower_id', '=', userId).get()) ?? []).map((row: any) => row.following_id))
      const blockedIds = await blockedUserIdsFor(userId)
      if (!canViewActivity(activity, userId, following, blockedIds))
        return response.json({ success: false, error: 'Activity not found' }, 404)

      const text = body.slice(0, 2000)
      const comment = await ActivityComment.forceCreate({
        user_id: userId,
        activity_id: activityId,
        body: text,
      })

      const user = await User.find(userId)

      // Notify the activity owner (skip commenting on your own activity).
      if (activity.user_id && activity.user_id !== userId) {
        await UserNotification.forceCreate({
          recipient_id: activity.user_id,
          actor_id: userId,
          actor_name: user?.name ?? 'Someone',
          type: 'comment',
          body: `${user?.name ?? 'Someone'} commented on your activity`,
          link: `/activity/${activityId}`,
          read: false,
        })
      }

      return response.json({
        success: true,
        comment: {
          id: comment.id,
          userId,
          userName: user?.name ?? 'Unknown',
          userAvatar: avatarOf(user),
          // The created model does not carry every column back: `body` and
          // `created_at` arrived undefined, so a new comment showed its
          // author with no text until the page was reloaded.
          body: comment.body ?? text,
          createdAt: comment.created_at ?? new Date().toISOString(),
        },
      }, 201)
    }
    catch (error) {
      console.error('Error creating comment:', error)
      return response.json({ success: false, error: 'Failed to add comment' }, 500)
    }
  },
})

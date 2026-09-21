// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// POST /api/activities/{id}/kudos - toggles the requesting user's kudos on an
// activity (idempotent: add if absent, remove if present), then recomputes the
// denormalized activities.kudos_count from the kudos rows.
import { Auth } from '@stacksjs/auth'

import { evaluateAchievementsForUser } from '../Achievement/EvaluateAchievementsAction'
import { wantsIt } from '../../Support/toggleIntent'

export default new Action({
  name: 'Toggle Kudos',
  description: 'Give or remove kudos on an activity',
  method: 'POST',

  async handle(request) {
    const activityId = positiveInt(request.get('id') ?? request.get('activity_id'))
    const giverId = (await Auth.user().catch(() => null))?.id

    // Field validation (#977).
    const fields: Record<string, string> = {}
    if (!activityId)
      fields.activity_id = 'required: a positive integer activity id'
    if (!giverId)
      fields.user_id = 'required: authenticated session'
    if (Object.keys(fields).length)
      return response.json({ success: false, error: 'Validation failed', fields }, 422)

    try {
      const activity = await Activity.find(activityId)
      if (!activity)
        return response.json({ success: false, error: 'Activity not found' }, 404)
      const following = new Set(((await Follow.where('follower_id', '=', giverId).get()) ?? []).map((row: any) => row.following_id))
      const blockedIds = await blockedUserIdsFor(giverId)
      if (!canViewActivity(activity, giverId, following, blockedIds))
        return response.json({ success: false, error: 'Activity not found' }, 404)

      const existing = await Kudos
        .where('giver_id', '=', giverId)
        .where('activity_id', '=', activityId)
        .first()

      const kudosed = wantsIt(request.method, Boolean(existing))
      const giving = kudosed && !existing
      if (!kudosed) {
        if (existing)
          await Kudos.delete(existing.id)
      }
      else if (giving) {
        try {
          await Kudos.forceCreate({
            giver_id: giverId,
            user_id: activity.user_id,
            activity_id: activityId,
          })
          // Notify the activity owner (skip self-kudos).
          if (activity.user_id && activity.user_id !== giverId) {
            const giver = await User.find(giverId)
            await UserNotification.forceCreate({
              recipient_id: activity.user_id,
              actor_id: giverId,
              actor_name: giver?.name ?? 'Someone',
              type: 'kudos',
              body: `${giver?.name ?? 'Someone'} gave kudos to your activity`,
              link: `/activity/${activityId}`,
              read: false,
            })
          }
        }
        catch (err) {
          // A concurrent double-tap can race the existence check above; the
          // unique index (#972) rejects the second insert - the kudos already
          // exists, so the toggle result stands (and the winner notified).
          if (!String(err).includes('UNIQUE constraint failed'))
            throw err
        }
      }

      // Recompute the denormalized counter from the source of truth.
      const all = await Kudos.where('activity_id', '=', activityId).get()
      const kudosCount = (all ?? []).length
      await Activity.forceUpdate(activityId, { kudos_count: kudosCount })

      // Unlock engine hook (#982): giving kudos moves Social Butterfly.
      if (giving) {
        await evaluateAchievementsForUser(giverId).catch((err: unknown) =>
          console.error('[achievements] evaluate after kudos failed:', err))
      }

      return response.json({ success: true, kudosed, kudosCount })
    }
    catch (error) {
      console.error('Error toggling kudos:', error)
      return response.json({ success: false, error: 'Failed to toggle kudos' }, 500)
    }
  },
})

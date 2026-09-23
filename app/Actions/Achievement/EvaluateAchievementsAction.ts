// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// The achievement unlock engine (#982). `evaluateAchievementsForUser` computes
// every metric from source-of-truth rows, upserts user_achievements progress,
// and notifies on fresh unlocks. It runs after the events that can move a
// metric (activity stored, territory claimed/conquered, kudos given) and is
// exposed as POST /api/achievements/evaluate for a manual refresh.
// Achievements never un-unlock: progress can fall (e.g. Empire Builder after
// losing land) but is_complete/completed_at are sticky once earned.

// eslint-disable-next-line pickier/no-unused-vars -- false positive: userId is used throughout the body
import { Auth } from '@stacksjs/auth'

export async function evaluateAchievementsForUser(userId: number): Promise<{
  evaluated: number
  unlocked: Array<{ id: number, name: string }>
}> {
  const definitions = (await Achievement.all()) ?? []
  if (!definitions.length)
    return { evaluated: 0, unlocked: [] }

  const activities = (await Activity.where('user_id', '=', userId).get()) ?? []
  const kudosGiven = (await Kudos.where('giver_id', '=', userId).get()) ?? []
  const stats = await TerritoryStats.where('user_id', '=', userId).first()

  // The fold itself lives in resources/functions/achievements.ts so the
  // database seeder computes a user's standing from exactly the same rules
  // this engine does, rather than a second copy of them.
  const metricValues = achievementMetricValues({ activities, kudosGiven, stats })

  const entries = computeAchievementProgress(definitions, metricValues)
  const existing = (await UserAchievement.where('user_id', '=', userId).get()) ?? []
  const existingByAchievement = new Map(existing.map((u: any) => [u.achievement_id, u]))

  const unlocked: Array<{ id: number, name: string }> = []
  for (const entry of entries) {
    const row = existingByAchievement.get(entry.achievement_id)
    const wasComplete = !!row?.is_complete
    const isComplete = wasComplete || entry.is_complete // sticky once earned
    const freshUnlock = entry.is_complete && !wasComplete

    if (row) {
      if (row.progress !== entry.progress || !!row.is_complete !== isComplete) {
        await UserAchievement.forceUpdate(row.id, {
          progress: entry.progress,
          is_complete: isComplete,
          completed_at: row.completed_at ?? (freshUnlock ? new Date().toISOString() : null),
        })
      }
    }
    else {
      try {
        await UserAchievement.forceCreate({
          user_id: userId,
          achievement_id: entry.achievement_id,
          progress: entry.progress,
          is_complete: isComplete,
          completed_at: freshUnlock ? new Date().toISOString() : null,
        })
      }
      catch (err) {
        // Concurrent evaluations can race; the unique index (#972) keeps one row.
        if (!String(err).includes('UNIQUE constraint failed'))
          throw err
      }
    }

    if (freshUnlock) {
      const def = definitions.find((d: any) => d.id === entry.achievement_id)
      unlocked.push({ id: entry.achievement_id, name: def?.name ?? 'Achievement' })
      try {
        await UserNotification.forceCreate({
          recipient_id: userId,
          actor_id: userId,
          actor_name: 'Wildloop',
          type: 'achievement',
          body: `Achievement unlocked: ${def?.icon ?? '🏅'} ${def?.name ?? ''}`.trim(),
          link: '/profile',
          read: false,
        })
      }
      catch (err) {
        console.error('[achievements] unlock notification failed:', err)
      }
    }
  }

  return { evaluated: entries.length, unlocked }
}

export default new Action({
  name: 'Evaluate Achievements',
  description: 'Recompute the acting user\'s achievement progress and unlocks',
  method: 'POST',

  async handle(request) {
    const userId = (await Auth.user().catch(() => null))?.id
    if (!userId)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    try {
      const result = await evaluateAchievementsForUser(userId)
      return response.json({ success: true, ...result })
    }
    catch (error) {
      console.error('Error evaluating achievements:', error)
      return response.json({ success: false, error: 'Failed to evaluate achievements' }, 500)
    }
  },
})

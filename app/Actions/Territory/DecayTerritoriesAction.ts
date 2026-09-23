// No imports needed - everything is auto-imported!
//
// POST /api/territories/decay-sweep (auth) - applies territory decay (#950).
//
// Rules (math in resources/functions/decay.ts):
//   active + owner inactive ≥ DECAY_STALE_DAYS   → 'contested' (decaying -
//     defendable by the owner exactly like an attack-contested territory)
//   contested + owner inactive ≥ DECAY_EXPIRE_DAYS → 'expired' (off the map,
//     the land becomes claimable again)
//
// The sweep runs opportunistically at the start of every conquest processing
// pass (every recorded run ticks the world clock) and via
// `buddy territory:decay` for cron. Owner activity - claim, conquest, defense,
// or simply running through own land - refreshes `last_activity_at`.

// eslint-disable-next-line pickier/no-unused-vars -- false positive: `opts` is used below
export async function runTerritoryDecaySweep(opts?: { staleDays?: number, expireDays?: number }): Promise<{
  contested: Array<{ id: number, name: string }>
  expired: Array<{ id: number, name: string }>
}> {
  const territories = (await Territory.whereIn('status', ['active', 'contested']).get()) ?? []
  const plan = computeTerritoryDecay(territories, opts ?? {})

  const contested: Array<{ id: number, name: string }> = []
  const expired: Array<{ id: number, name: string }> = []

  for (const t of plan.toContest) {
    try {
      await Territory.forceUpdate(t.id, { status: 'contested' })
      await TerritoryHistory.forceCreate({
        territory_id: t.id,
        user_id: t.user_id,
        activity_id: null,
        previous_owner_id: null,
        event_type: 'contested',
        area_at_event: t.area_size,
        notes: 'Territory decaying, owner inactive',
      })
      contested.push({ id: t.id, name: t.name ?? `Territory #${t.id}` })
      await notifyOwner(t.user_id, 'conquest_attack', `${t.name ?? 'Your territory'} is decaying. Run through it to defend it!`, `/territory/${t.id}`)
    }
    catch (error) {
      console.error(`Decay contest failed for territory #${t.id}:`, error)
    }
  }

  for (const t of plan.toExpire) {
    try {
      const ownershipDuration = t.claimed_at
        ? Math.floor((Date.now() - new Date(t.claimed_at).getTime()) / 1000)
        : 0

      await Territory.forceUpdate(t.id, { status: 'expired' })
      await TerritoryHistory.forceCreate({
        territory_id: t.id,
        user_id: t.user_id,
        activity_id: null,
        previous_owner_id: t.user_id,
        event_type: 'expired',
        area_at_event: t.area_size,
        previous_ownership_duration: ownershipDuration,
        notes: 'Territory expired, owner inactive too long',
      })
      await applyExpiryStats(t.user_id, t.area_size || 0, ownershipDuration)

      expired.push({ id: t.id, name: t.name ?? `Territory #${t.id}` })
      await notifyOwner(t.user_id, 'conquest_attack', `${t.name ?? 'Your territory'} expired after inactivity. The land is up for grabs.`, `/territories`)
    }
    catch (error) {
      console.error(`Decay expiry failed for territory #${t.id}:`, error)
    }
  }

  return { contested, expired }
}

export default new Action({
  name: 'Decay Territories',
  description: 'Apply territory decay: stale land becomes contested, abandoned land expires',
  method: 'POST',

  async handle(request) {
    try {
      // Field validation (#977): both knobs optional, but must be sane days.
      const fields: Record<string, string> = {}
      const staleRaw = request.get('stale_days')
      const expireRaw = request.get('expire_days')
      const staleDays = staleRaw === undefined || staleRaw === null ? undefined : boundedNumber(staleRaw, 1, 3650)
      const expireDays = expireRaw === undefined || expireRaw === null ? undefined : boundedNumber(expireRaw, 1, 3650)
      if (staleRaw !== undefined && staleRaw !== null && staleDays === null)
        fields.stale_days = 'must be a number of days between 1 and 3650'
      if (expireRaw !== undefined && expireRaw !== null && expireDays === null)
        fields.expire_days = 'must be a number of days between 1 and 3650'
      if (Object.keys(fields).length)
        return response.json({ success: false, error: 'Validation failed', fields }, 422)

      const result = await runTerritoryDecaySweep({
        staleDays: staleDays ?? undefined,
        expireDays: expireDays ?? undefined,
      })

      return response.json({
        success: true,
        contestedCount: result.contested.length,
        expiredCount: result.expired.length,
        contested: result.contested,
        expired: result.expired,
      })
    }
    catch (error) {
      console.error('Error running decay sweep:', error)
      return response.json({ success: false, error: 'Failed to run decay sweep' }, 500)
    }
  },
})

/** Expiry is a loss: current holdings shrink, lifetime lost counter grows. */
async function applyExpiryStats(userId: number, area: number, ownershipDurationSeconds: number) {
  const stats = await TerritoryStats.where('user_id', '=', userId).first()
  if (!stats)
    return
  const ownershipDays = Math.floor(ownershipDurationSeconds / 86400)
  await TerritoryStats.forceUpdate(stats.id, {
    total_territories_owned: Math.max(0, (stats.total_territories_owned || 0) - 1),
    total_area_owned: Math.max(0, (stats.total_area_owned || 0) - area),
    territories_lost: (stats.territories_lost || 0) + 1,
    longest_ownership_days: Math.max(stats.longest_ownership_days || 0, ownershipDays),
  })
}

/** Best-effort notification - never lets a notify failure break the sweep. */
async function notifyOwner(recipientId: number, type: string, body: string, link: string) {
  try {
    const owner = await User.find(recipientId)
    await UserNotification.forceCreate({
      recipient_id: recipientId,
      actor_id: recipientId,
      actor_name: owner?.name ?? 'Wildloop',
      type,
      body,
      link,
      read: false,
    })
  }
  catch (error) {
    console.error('Failed to write decay notification:', error)
  }
}

import { Auth } from '@stacksjs/auth'
import { isAnsweredContest } from '../../Support/battleRows'

const BATTLE_EVENTS = ['conquered', 'split', 'contested', 'defended']

export default new Action({
  name: 'Territory Battle Index',
  description: 'Recent persisted territory battle events and currently contested land',
  method: 'GET',
  async handle(request) {
    const limit = Math.min(200, Math.max(1, Number(request.get('limit') || 100)))
    const viewerId = (await Auth.user().catch(() => null))?.id ?? null
    const blockedIds = await blockedUserIdsFor(viewerId)
    const rows = ((await TerritoryHistory.whereIn('event_type', BATTLE_EVENTS).orderBy('created_at', 'desc').limit(limit).get()) ?? [])
      .filter((row: any) => !blockedIds.has(row.user_id) && !blockedIds.has(row.previous_owner_id))
    const territoryIds = [...new Set(rows.map((row: any) => row.territory_id).filter(Boolean))]
    const activityIds = [...new Set(rows.map((row: any) => row.activity_id).filter(Boolean))]
    const [territories, activities] = await Promise.all([
      territoryIds.length ? Territory.whereIn('id', territoryIds).get() : [],
      activityIds.length ? Activity.whereIn('id', activityIds).get() : [],
    ])
    // A contest names no previous owner on its row: the land stayed with its
    // owner, who is the defender. Without the owners in this lookup every
    // live battle read "<attacker> vs the previous owner".
    const userIds = [...new Set([
      ...rows.flatMap((row: any) => [row.user_id, row.previous_owner_id]),
      ...territories.map((territory: any) => territory.user_id),
    ].filter(Boolean))]
    const users = userIds.length ? await User.whereIn('id', userIds).get() : []
    const territoryMap = new Map(territories.map((row: any) => [row.id, row]))
    const userMap = new Map(users.map((row: any) => [row.id, row]))
    const activityMap = new Map(activities.map((row: any) => [row.id, row]))
    // The board reads every row as "<attacker> conquered / failed to conquer
    // <territory> from <defender>", so both sides have to be real people on
    // every event type. Only `conquered` and `split` name an attacker AND a
    // previous owner on the row itself:
    //
    //   - `contested` records an attack that did not take the land, so the
    //     defender is the owner, who has not changed.
    //   - `defended` records the OWNER running their own contested land. Its
    //     `user_id` is the defender, not an attacker — the attacker is
    //     whoever contested the territory last, which is the event this one
    //     answers.
    //
    // Reading them all off `row.user_id` reported a defence as "Mark Dowdle
    // failed to conquer Defense held", and a repelled contest as a conquest.
    const nameOf = (id: number | null | undefined, fallback: string): string =>
      (id ? userMap.get(id)?.name : null) ?? fallback

    /** The most recent contest on this territory before `row`. */
    const contesterBefore = (row: any): number | null => {
      // `rows` is newest-first, so the first contest after this row's position
      // in the list is the most recent one that preceded it in time.
      const index = rows.indexOf(row)
      for (let i = index + 1; i < rows.length; i++) {
        const earlier = rows[i]
        if (earlier.territory_id === row.territory_id && earlier.event_type === 'contested')
          return earlier.user_id ?? null
      }
      return null
    }

    const battles = rows.filter((row: any) => !isAnsweredContest(rows, row)).map((row: any) => {
      const territory = territoryMap.get(row.territory_id)
      const activity = activityMap.get(row.activity_id)

      const takeover = row.event_type === 'conquered' || row.event_type === 'split'
      const defence = row.event_type === 'defended'
      // A contest is live only while the land is still marked contested; once
      // the owner has run it back it is a defence that already happened.
      const status = takeover
        ? 'conquered'
        : defence || territory?.status !== 'contested' ? 'defended' : 'active'

      const attackerId = defence ? contesterBefore(row) : row.user_id
      const defenderId = defence
        ? row.user_id
        : row.previous_owner_id ?? territory?.user_id ?? null

      return {
        id: row.id,
        territory_id: row.territory_id,
        territoryName: territory?.name ?? `Territory #${row.territory_id}`,
        attacker_id: attackerId ?? 0,
        attackerName: nameOf(attackerId, 'An attacker'),
        defender_id: defenderId ?? 0,
        defenderName: nameOf(defenderId, 'the previous owner'),
        status,
        areaCaptured: row.area_at_event ?? 0,
        runDistance: activity?.distance ?? 0,
        description: row.notes ?? '',
        created_at: row.created_at,
      }
    })
    return response.json({ success: true, battles, updatedAt: new Date().toISOString(), pollAfterSeconds: 15 })
  },
})


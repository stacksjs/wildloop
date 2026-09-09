import { onMount, state } from 'stx'
import { readyToken } from '../assets/scripts/auth'

/**
 * Hydrate the `wl` store's activity feed from the live API
 * (`GET /api/activities`), mirroring useTrailCatalog/useTerritoryCatalog. Falls
 * back silently to seed data when the API is empty/unreachable.
 */

interface ActivityStoreLike {
  activities: () => unknown[]
  hydrateActivitiesFromApi: (activities: unknown[]) => void
}

interface ApiActivity {
  id: number
  userId: number
  userName: string
  trailId: number | null
  trailName: string | null
  title: string
  activityType: string
  distance: number
  duration: string
  movingTime: string
  pace: string | null
  elevationGain: number
  calories: number
  kudosCount: number
  splits?: Array<{ mile: number, pace: string, elev: number }>
  notes?: string | null
  hasGps?: boolean
  /**
   * The shape of the run, thinned for a card-sized preview and with the start
   * and end blurred when it belongs to somebody else. Served by the activity
   * index — the browser cannot derive it, because the trail geometry it would
   * need is not in the store.
   *
   * `[lat, lng]` pairs, which is what the preview renderer indexes.
   */
  route?: Array<[number, number]>
  visibility?: string
  completedAt: string | null
  createdAt: string | null
}

export const activitySource = state<'api' | 'seed'>('seed')
export const activityError = state<string | null>(null)

let activitiesStarted = false

export async function loadActivities(wl: ActivityStoreLike): Promise<void> {
  try {
    const bearer = await readyToken()
    const res = await fetch('/api/activities?limit=200', {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
    })
    if (!res.ok)
      throw new Error(`Activities API returned ${res.status}`)
    const payload = await res.json()
    const rows: ApiActivity[] = Array.isArray(payload?.activities) ? payload.activities : []

    // Same reasoning as the territory catalog: an empty feed is a real
    // answer. Returning early here left the store's demo activities on
    // screen, so a new account saw runs by people who do not exist rather
    // than an empty feed inviting them to record one.
    if (!rows.length) {
      wl.hydrateActivitiesFromApi([])
      activitySource.set('api')
      return
    }

    const activities = rows.map(a => ({
      id: a.id,
      user_id: a.userId,
      userName: a.userName || 'Unknown',
      trail_id: a.trailId ?? null,
      trail_name: a.trailName ?? `${a.activityType} Activity`,
      title: a.title,
      activityType: a.activityType,
      distance: a.distance,
      duration: a.duration,
      moving_time: a.movingTime ?? a.duration,
      pace: a.pace ?? '--',
      elevation_gain: a.elevationGain ?? 0,
      calories: a.calories ?? 0,
      heartRateAvg: null,
      heartRateMax: null,
      cadence: null,
      splits: Array.isArray(a.splits) ? a.splits : [],
      kudos_count: a.kudosCount ?? 0,
      comments: [],
      notes: a.notes ?? '',
      visibility: a.visibility ?? 'public',
      hasGps: a.hasGps ?? false,
      route: Array.isArray(a.route) ? a.route : [],
      created_at: a.createdAt ?? a.completedAt ?? new Date().toISOString(),
    }))

    wl.hydrateActivitiesFromApi(activities)
    activitySource.set('api')
  }
  catch (err) {
    activityError.set(err instanceof Error ? err.message : 'Could not load activities')
    activitySource.set('seed')
  }
}

export function useActivityCatalog(wl: ActivityStoreLike | null) {
  onMount(async () => {
    if (!wl || activitiesStarted)
      return
    activitiesStarted = true
    await loadActivities(wl)
  })
}

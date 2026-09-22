import { durationSeconds } from './training-stats'

/**
 * An athlete's personal bests and their year in miles, for the Achievements
 * screen. Worked out from the athlete's own activities, as the API returns
 * them (`/api/activities?user_id=`), so nothing here needs its own endpoint.
 */

export interface BestsActivity {
  id: number
  title?: string | null
  distance?: number | null
  movingTime?: string | null
  duration?: string | null
  elevationGain?: number | null
  completedAt?: string | null
  createdAt?: string | null
}

export type PersonalBestKey = 'distance' | 'time' | 'elevation'

export interface PersonalBest {
  key: PersonalBestKey
  label: string
  /** Display value, e.g. `4.9 mi`, `1h 46m`, `866 ft`. */
  value: string
  /** The activity that set it, for Share. */
  activityId: number
  activityTitle: string
}

export interface MonthProgress {
  /** 0 = January. */
  month: number
  label: string
  miles: number
}

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D']

function whenOf(activity: BestsActivity): Date | null {
  const raw = activity.completedAt ?? activity.createdAt
  if (!raw)
    return null
  const date = new Date(raw)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatMiles(miles: number): string {
  return `${miles >= 100 ? Math.round(miles) : Math.round(miles * 10) / 10} mi`
}

export function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
}

export function formatFeet(feet: number): string {
  return `${Math.round(feet).toLocaleString('en-US')} ft`
}

function best(
  activities: BestsActivity[],
  measure: (activity: BestsActivity) => number,
): { activity: BestsActivity, amount: number } | null {
  let top: { activity: BestsActivity, amount: number } | null = null
  for (const activity of activities) {
    const amount = measure(activity)
    // A tie keeps the earlier record: whoever set it first holds it.
    if (amount > 0 && (!top || amount > top.amount))
      top = { activity, amount }
  }
  return top
}

/**
 * The records in the order the screen shows them. A record with nothing
 * behind it (no elevation on any activity, say) is left out rather than
 * shown as zero.
 */
export function personalBests(activities: BestsActivity[]): PersonalBest[] {
  const records: PersonalBest[] = []
  const add = (key: PersonalBestKey, label: string, found: ReturnType<typeof best>, format: (amount: number) => string) => {
    if (!found)
      return
    records.push({
      key,
      label,
      value: format(found.amount),
      activityId: found.activity.id,
      activityTitle: found.activity.title || 'An activity',
    })
  }

  add('distance', 'Longest activity', best(activities, a => a.distance ?? 0), formatMiles)
  // Moving time, as pace is: time stood at a trailhead is not time outside
  // on the trail. The wall clock is the fallback for activities without it.
  add('time', 'Most time outside', best(activities, a => durationSeconds(a.movingTime ?? a.duration)), formatDuration)
  add('elevation', 'Most elev. gain', best(activities, a => a.elevationGain ?? 0), formatFeet)
  return records
}

/** Miles per month of `year`, January to December. */
export function monthlyProgress(activities: BestsActivity[], year: number): MonthProgress[] {
  const miles = Array.from({ length: 12 }, () => 0)
  for (const activity of activities) {
    const when = whenOf(activity)
    if (when && when.getFullYear() === year)
      miles[when.getMonth()] += activity.distance ?? 0
  }
  return miles.map((total, month) => ({ month, label: MONTHS[month], miles: Math.round(total * 10) / 10 }))
}

/** The text a record is shared with. */
export function shareText(record: PersonalBest): string {
  return `${record.label}: ${record.value} on WildLoop`
}

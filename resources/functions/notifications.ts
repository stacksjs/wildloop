/**
 * What a notification list is, independent of how it is drawn.
 *
 * The web page and the native screen show the same alerts in different
 * idioms — chips and day headings against grouped iOS sections — and they must
 * agree on which alerts those are, which day each one belongs to, and how long
 * ago it arrived. So the filtering, the bucketing, the row shape and the
 * relative time live here, and each screen keeps only its own presentation.
 */

export const NOTIFICATION_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'conquest', label: 'Conquests' },
  { key: 'kudos', label: 'Kudos' },
  { key: 'challenge', label: 'Challenges' },
] as const

export type NotificationFilter = typeof NOTIFICATION_FILTERS[number]['key']

export interface NotificationRow {
  id: number
  type: string
  title: string
  message: string
  link: string
  read: boolean
  created_at: string
}

/**
 * The API's shape as the row both screens render.
 *
 * `actorName` is the person who did the thing, and the fallback is the product
 * rather than an empty line: a notification with no actor is one Wildloop sent.
 */
export function notificationRowsFrom(payload: unknown): NotificationRow[] {
  const list = (payload as { notifications?: unknown[] })?.notifications
  if (!Array.isArray(list))
    return []

  return list.map((entry) => {
    const row = entry as Record<string, unknown>
    return {
      id: Number(row.id) || 0,
      type: String(row.type ?? ''),
      title: String(row.actorName || 'Wildloop'),
      message: String(row.body ?? ''),
      link: String(row.link || '#'),
      read: Boolean(row.read),
      created_at: String(row.createdAt ?? row.created_at ?? ''),
    }
  })
}

/**
 * Whether a row belongs under a chip.
 *
 * `conquest` is a prefix rather than a type: the attack, the defence and the
 * win are three types and one thing somebody is looking for.
 */
export function matchesNotificationFilter(row: { type: string, read: boolean }, filter: NotificationFilter): boolean {
  if (filter === 'all')
    return true
  if (filter === 'unread')
    return !row.read
  if (filter === 'conquest')
    return row.type.startsWith('conquest')
  return row.type === filter
}

export interface NotificationDay<T> {
  label: string
  items: T[]
}

/**
 * Today, Yesterday, Earlier — and no empty headings.
 *
 * Measured against `now` as a parameter rather than read from the clock, so a
 * test can sit at a particular moment instead of near one.
 */
export function groupNotificationsByDay<T extends { created_at: string }>(
  rows: readonly T[],
  now: number = Date.now(),
): NotificationDay<T>[] {
  const DAY = 86_400_000
  const buckets: NotificationDay<T>[] = [
    { label: 'Today', items: [] },
    { label: 'Yesterday', items: [] },
    { label: 'Earlier', items: [] },
  ]

  for (const row of rows) {
    const age = now - new Date(row.created_at).getTime()
    if (!Number.isFinite(age) || age >= DAY * 2)
      buckets[2].items.push(row)
    else if (age >= DAY)
      buckets[1].items.push(row)
    else
      buckets[0].items.push(row)
  }

  return buckets.filter(bucket => bucket.items.length > 0)
}

/**
 * "4h ago", in the one place that decides it.
 *
 * The `wl` store's `timeAgo` delegates here so a feed card, a notification row
 * and a native screen cannot describe the same instant three ways.
 */
export function timeAgo(value: string, now: number = Date.now()): string {
  if (!value)
    return ''

  const then = new Date(value).getTime()
  if (!Number.isFinite(then))
    return ''

  const minutes = Math.floor((now - then) / 60_000)
  if (minutes < 1)
    return 'just now'
  if (minutes < 60)
    return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24)
    return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 7)
    return `${days}d ago`

  return `${Math.floor(days / 7)}w ago`
}

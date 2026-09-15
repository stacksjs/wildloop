import { onMount } from 'stx'
import { fetchNotifications } from '../assets/scripts/game-api'

/**
 * Hydrate the current user's notifications from the API into the `wl` store so
 * the notifications page + nav unread badge reflect real kudos/comment/follow
 * events.
 *
 * An empty answer is an answer. This used to return early on a zero-length
 * list and leave the store's demo notifications in place, so an account with
 * nothing waiting for it was shown fabricated alerts about people who do not
 * exist — including a "Territory Under Attack!" alarm — and an unread badge
 * counting them. Only a failed request falls back now, which is the same rule
 * the trail catalog applies for the same reason.
 */

interface NotificationStoreLike {
  notifications: () => unknown[]
  hydrateNotifications: (list: unknown[]) => void
}

let notificationsStarted = false

export async function hydrateNotifications(wl: NotificationStoreLike | null): Promise<void> {
  if (!wl || notificationsStarted)
    return
  notificationsStarted = true
  try {
    const data = await fetchNotifications()
    if (!data || !Array.isArray(data.notifications))
      return
    // Map the API shape to the store's Notification shape.
    const mapped = data.notifications.map((n: any) => ({
      id: n.id,
      type: n.type,
      title: n.actorName || 'WildLoop',
      message: n.body,
      link: n.link || '#',
      read: !!n.read,
      created_at: n.createdAt,
    }))
    wl.hydrateNotifications(mapped)
  }
  catch {
    // keep seed notifications
  }
}

export function useNotifications(wl: NotificationStoreLike | null) {
  onMount(() => void hydrateNotifications(wl))
}

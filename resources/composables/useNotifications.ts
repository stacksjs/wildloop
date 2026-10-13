import { onMount } from 'stx'
import { fetchNotifications } from '../assets/scripts/game-api'
import { notificationRowsFrom } from '../functions/notifications'

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
    // The API shape as the row both screens render, from the one module that
    // decides it (resources/functions/notifications.ts).
    wl.hydrateNotifications(notificationRowsFrom(data))
  }
  catch {
    // keep seed notifications
  }
}

export function useNotifications(wl: NotificationStoreLike | null) {
  onMount(() => void hydrateNotifications(wl))
}

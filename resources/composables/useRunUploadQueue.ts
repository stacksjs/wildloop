import { onDestroy, onMount, state } from 'stx'
import { readyToken } from '../assets/scripts/auth'
import { persistRunAndProcess } from '../assets/scripts/game-api'
import { MAX_UPLOAD_ATTEMPTS, flushQueuedRuns, queuedRuns } from '../assets/scripts/run-upload-queue'
import { loadActivities } from './useActivityCatalog'

interface QueueStoreLike {
  currentUserId: () => number
  activities: () => unknown[]
  hydrateActivitiesFromApi: (activities: unknown[]) => void
}

export const pendingRunUploads = state(0)
export const runUploadQueueMessage = state<string | null>(null)

export function useRunUploadQueue(wl: QueueStoreLike | null) {
  let flushing = false
  let retryTimer: ReturnType<typeof setTimeout> | null = null

  const scheduleRetry = async () => {
    if (retryTimer) clearTimeout(retryTimer)
    const ownerId = wl?.currentUserId() ?? 0
    if (!ownerId) return
    const retryable = (await queuedRuns(ownerId)).filter(row => (row.attempts ?? 0) < MAX_UPLOAD_ATTEMPTS)
    if (!retryable.length) return
    const next = Math.min(...retryable.map(row => row.nextAttemptAt ? Date.parse(row.nextAttemptAt) : Date.now()))
    retryTimer = setTimeout(() => void flush(), Math.max(250, next - Date.now()))
  }

  const refreshCount = async () => {
    const ownerId = wl?.currentUserId() ?? 0
    pendingRunUploads.set(ownerId ? (await queuedRuns(ownerId)).length : 0)
  }

  const flush = async () => {
    const ownerId = wl?.currentUserId() ?? 0
    if (!wl || !ownerId || flushing || (typeof navigator !== 'undefined' && !navigator.onLine))
      return
    // Signed out, every upload would only come back 401. The runs wait for
    // their owner to sign in again, which reloads the page and flushes.
    if (!await readyToken())
      return
    flushing = true
    try {
      const result = await flushQueuedRuns(
        ownerId,
        payload => persistRunAndProcess(payload, { queueOnFailure: false }),
      )
      pendingRunUploads.set(result.remaining)
      if (result.failed > 0)
        runUploadQueueMessage.set(`${result.failed} offline ${result.failed === 1 ? 'activity needs' : 'activities need'} attention after repeated upload failures`)
      if (result.uploaded > 0) {
        runUploadQueueMessage.set(`${result.uploaded} offline ${result.uploaded === 1 ? 'activity' : 'activities'} uploaded`)
        await loadActivities(wl)
      }
    }
    finally {
      flushing = false
      void scheduleRetry()
    }
  }

  const handleOnline = () => void flush()

  onMount(() => {
    void refreshCount().then(flush)
    if (typeof window !== 'undefined')
      window.addEventListener('online', handleOnline)
  })

  onDestroy(() => {
    if (retryTimer) clearTimeout(retryTimer)
    if (typeof window !== 'undefined')
      window.removeEventListener('online', handleOnline)
  })

  return { pendingRunUploads, runUploadQueueMessage, flush }
}

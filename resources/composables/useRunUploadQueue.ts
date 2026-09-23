import { onDestroy, onMount, state } from 'stx'
import { currentUser, readyToken } from '../assets/scripts/auth'
import { persistRunAndProcess } from '../assets/scripts/game-api'
import { flushQueuedRuns, queuedRunDisposition, queuedRuns } from '../assets/scripts/run-upload-queue'
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
  let destroyed = false
  let retryGeneration = 0

  const scheduleRetry = async () => {
    const version = ++retryGeneration
    if (retryTimer) clearTimeout(retryTimer)
    const ownerId = wl?.currentUserId() ?? 0
    if (!ownerId || destroyed) return
    const retryable = (await queuedRuns(ownerId)).filter(row => queuedRunDisposition(row) !== 'failed')
    if (!retryable.length || destroyed || version !== retryGeneration) return
    const next = Math.min(...retryable.map(row => row.nextAttemptAt ? Date.parse(row.nextAttemptAt) : Date.now()))
    retryTimer = setTimeout(() => void flush(), Math.max(250, next - Date.now()))
  }

  const refreshCount = async () => {
    const ownerId = wl?.currentUserId() ?? 0
    pendingRunUploads.set(ownerId ? (await queuedRuns(ownerId)).length : 0)
  }

  const flush = async () => {
    const ownerId = wl?.currentUserId() ?? 0
    if (!wl || !ownerId || flushing || destroyed || (typeof navigator !== 'undefined' && !navigator.onLine))
      return
    flushing = true
    try {
      // Lock before awaiting session restoration: auth-ready can reenter flush.
      if (!await readyToken() || currentUser()?.id !== ownerId) return
      const result = await flushQueuedRuns(
        ownerId,
        payload => {
          if (currentUser()?.id !== ownerId)
            throw Object.assign(new Error('Sign in to the account that recorded this activity.'), { status: 401 })
          return persistRunAndProcess(payload, { queueOnFailure: false })
        },
      )
      pendingRunUploads.set(result.remaining)
      if (result.failed > 0)
        runUploadQueueMessage.set(`${result.failed} offline ${result.failed === 1 ? 'activity needs' : 'activities need'} attention. Open Record to recover it.`)
      if (result.uploaded > 0) {
        runUploadQueueMessage.set(`${result.uploaded} offline ${result.uploaded === 1 ? 'activity' : 'activities'} uploaded`)
        await loadActivities(wl)
      }
    }
    catch {
      runUploadQueueMessage.set('Device storage could not be read. Keep this page open and try again.')
    }
    finally {
      flushing = false
      void scheduleRetry().catch(() => undefined)
    }
  }

  const handleOnline = () => void flush()
  const handleChanged = () => void refreshCount().then(scheduleRetry).catch(() => undefined)
  const handleAuth = () => { handleChanged(); handleOnline() }

  onMount(() => {
    void refreshCount().then(flush).catch(() => undefined)
    if (typeof window !== 'undefined') {
      window.addEventListener('online', handleOnline)
      window.addEventListener('wildloop:uploads-changed', handleChanged)
      window.addEventListener('wildloop:retry-uploads', handleOnline)
      window.addEventListener('wildloop:auth-ready', handleAuth)
    }
  })

  onDestroy(() => {
    destroyed = true
    if (retryTimer) clearTimeout(retryTimer)
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('wildloop:uploads-changed', handleChanged)
      window.removeEventListener('wildloop:retry-uploads', handleOnline)
      window.removeEventListener('wildloop:auth-ready', handleAuth)
    }
  })

  return { pendingRunUploads, runUploadQueueMessage, flush }
}

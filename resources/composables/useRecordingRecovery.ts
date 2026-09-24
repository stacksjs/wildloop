import { onDestroy, onMount, state } from 'stx'
import { currentUser } from '../assets/scripts/auth'
import { discardFailedQueuedRun, exportQueuedRun, queuedRunDisposition, queuedRuns, retryQueuedRun, type QueuedRun } from '../assets/scripts/run-upload-queue'

export function useRecordingRecovery() {
  const recordings = state<Array<QueuedRun & { needsAttention: boolean }>>([])
  const recoveryMessage = state('')
  const recoveringUpload = state('')
  let generation = 0
  let destroyed = false
  const owner = () => Number(currentUser()?.id) || 0
  const refresh = async () => {
    const version = ++generation
    const ownerId = owner()
    recordings.set([])
    if (!ownerId) return
    try {
      const rows = await queuedRuns(ownerId)
      if (!destroyed && version === generation && owner() === ownerId)
        recordings.set(rows.map(row => ({ ...row, needsAttention: queuedRunDisposition(row) === 'failed' })))
    }
    catch {
      if (!destroyed && version === generation)
        recoveryMessage.set('Could not read saved recordings on this device. Keep this page open and try again.')
    }
  }

  const recover = async (uploadId: string, download: boolean) => {
    if (recoveringUpload()) return
    const ownerId = owner()
    recoveringUpload.set(uploadId)
    recoveryMessage.set('')
    try {
      if (download) {
        const json = await exportQueuedRun(ownerId, uploadId)
        if (owner() !== ownerId) throw new Error('Sign in to the account that recorded this activity.')
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
        const link = document.createElement('a')
        link.href = url
        link.download = `wildloop-recording-${uploadId.replace(/[^a-z0-9_-]/gi, '_')}.json`
        document.body.append(link)
        link.click()
        link.remove()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
        recoveryMessage.set('Backup downloaded. It includes your precise GPS route. Keep it private. The recording is still on this device.')
      }
      else {
        await retryQueuedRun(ownerId, uploadId)
        recoveryMessage.set('Retry requested. Stay signed in and connected. If rejected again, your recording stays here.')
      }
    }
    catch (error) {
      recoveryMessage.set(error instanceof Error ? error.message : 'Could not recover this recording. Try again.')
    }
    finally {
      recoveringUpload.set('')
      await refresh()
    }
  }

  const discardRecording = async (uploadId: string) => {
    if (recoveringUpload()) return
    const ownerId = owner()
    recoveringUpload.set(uploadId)
    recoveryMessage.set('')
    try {
      await discardFailedQueuedRun(ownerId, uploadId)
      recoveryMessage.set('Recording discarded from this device.')
    }
    catch (error) {
      recoveryMessage.set(error instanceof Error ? error.message : 'Could not discard this recording. Try again.')
    }
    finally {
      recoveringUpload.set('')
      await refresh()
    }
  }

  const changed = () => void refresh()
  onMount(() => {
    void refresh()
    globalThis.addEventListener('wildloop:uploads-changed', changed)
    globalThis.addEventListener('wildloop:auth-ready', changed)
  })
  onDestroy(() => {
    destroyed = true
    globalThis.removeEventListener('wildloop:uploads-changed', changed)
    globalThis.removeEventListener('wildloop:auth-ready', changed)
  })
  return {
    recordings, recoveryMessage, recoveringUpload,
    retryRecording: (id: string) => recover(id, false),
    exportRecording: (id: string) => recover(id, true),
    discardRecording,
  }
}

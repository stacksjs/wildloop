import { enqueueRun, queuedRuns, removeQueuedRun } from '../../resources/assets/scripts/run-upload-queue'
import { clearRecordingCheckpoint, loadRecordingCheckpoint, saveRecordingCheckpoint } from '../../resources/assets/scripts/recording-checkpoint'
import { saveFinishedRecording } from '../../resources/assets/scripts/finished-recording'
import { installRecordingNavigationGuard, requestRecordingExit } from '../../resources/assets/scripts/recording-navigation'

const output = document.querySelector('pre')!
const run = document.querySelector('button')!
const payload = {
  user_id: 700001,
  activity_type: 'Hike',
  distance: 1,
  duration: '20:00',
  upload_id: 'browser-storage-rollback',
}

run.addEventListener('click', async () => {
  run.setAttribute('disabled', '')
  output.textContent = 'Running against real browser IndexedDB...'
  try {
    await removeQueuedRun(payload.upload_id)
    // Force a real transaction rollback after the put succeeds. This is not
    // a fake database: the browser must roll back its own persisted write.
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      const request = originalPut.apply(this, args)
      if (this.name === 'run-uploads')
        request.addEventListener('success', () => this.transaction.abort())
      return request
    }
    let rejected = false
    try {
      await enqueueRun(payload)
    }
    catch {
      rejected = true
    }
    finally {
      IDBObjectStore.prototype.put = originalPut
    }
    const recovered = await queuedRuns(payload.user_id)
    if (!rejected || recovered.length)
      throw new Error(`Aborted write: rejected=${rejected}, recoverable=${recovered.length}. Must reject without claiming a save.`)
    await enqueueRun(payload)
    if ((await queuedRuns(payload.user_id)).length !== 1)
      throw new Error('A committed recording was not recoverable')
    await removeQueuedRun(payload.upload_id)
    await clearRecordingCheckpoint()
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      const request = originalPut.apply(this, args)
      if (this.name === 'recording-checkpoints')
        request.addEventListener('success', () => this.transaction.abort())
      return request
    }
    rejected = false
    try {
      await saveRecordingCheckpoint({
        userId: payload.user_id, activityType: 'Hike', visibility: 'private',
        runMode: 'free', targetTerritoryId: null, startedAtMs: 1000,
        elapsed: 10, distance: 0.01, elevation: 0, paused: false, samples: [],
      })
    }
    catch {
      rejected = true
    }
    finally {
      IDBObjectStore.prototype.put = originalPut
    }
    if (!rejected || await loadRecordingCheckpoint())
      throw new Error(`Aborted checkpoint: rejected=${rejected}. Recovery must never be promised before commit.`)
    const checkpoint = {
      userId: payload.user_id, activityType: 'Hike' as const, visibility: 'private',
      runMode: 'free' as const, targetTerritoryId: null, startedAtMs: 1000,
      elapsed: 10, distance: 0.01, elevation: 0, paused: true, samples: [],
    }
    // This harness refuses uploads at its HTTP boundary. Make the
    // queue fail too, but leave recovery storage working.
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      const request = originalPut.apply(this, args)
      if (this.name === 'run-uploads')
        request.addEventListener('success', () => this.transaction.abort())
      return request
    }
    rejected = false
    try {
      await saveFinishedRecording(checkpoint, payload)
    }
    catch {
      rejected = true
    }
    finally {
      IDBObjectStore.prototype.put = originalPut
    }
    const pending = await loadRecordingCheckpoint()
    if (!rejected || pending?.pendingUpload?.upload_id !== payload.upload_id)
      throw new Error('A failed upload and failed queue must preserve the finished recording and its retry identity')
    const retried = await saveFinishedRecording(checkpoint, pending.pendingUpload)
    if (!retried.queued || await loadRecordingCheckpoint())
      throw new Error('Confirmed offline storage should transfer the finished recording out of the recovery checkpoint')
    const queued = await queuedRuns(payload.user_id)
    if (queued.length !== 1 || queued[0].payload.upload_id !== payload.upload_id)
      throw new Error('Retry changed the recording identity or lost its payload')
    await removeQueuedRun(payload.upload_id)
    for (const status of [401, 422]) {
      const refused = { ...payload, upload_id: `${payload.upload_id}:${status}` }
      const result = await saveFinishedRecording(checkpoint, refused)
      const rows = await queuedRuns(payload.user_id)
      if (!result.queued || !rows.some(row => row.uploadId === refused.upload_id))
        throw new Error(`HTTP ${status} lost its recoverable track`)
      if (status === 401 && !result.error?.includes('Sign in again'))
        throw new Error('An expired session must explain how to resume uploading')
      await removeQueuedRun(refused.upload_id)
    }
    // If the final checkpoint update fails, the last active checkpoint must
    // retain the identity assigned at Start, not invent a second activity.
    await saveRecordingCheckpoint({ ...checkpoint, uploadId: payload.upload_id })
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      const request = originalPut.apply(this, args)
      request.addEventListener('success', () => this.transaction.abort())
      return request
    }
    try {
      await saveFinishedRecording(checkpoint, payload).catch(() => undefined)
    }
    finally {
      IDBObjectStore.prototype.put = originalPut
    }
    const interrupted = await loadRecordingCheckpoint()
    if (interrupted?.uploadId !== payload.upload_id || interrupted.pendingUpload)
      throw new Error('A failed final checkpoint replaced the active recording identity')
    let foreignOwnerRejected = false
    try {
      await saveFinishedRecording({ ...checkpoint, userId: payload.user_id + 1 }, payload)
    }
    catch {
      foreignOwnerRejected = true
    }
    if (!foreignOwnerRejected || (await loadRecordingCheckpoint())?.uploadId !== payload.upload_id)
      throw new Error('Another account must not replace a recording checkpoint')
    await clearRecordingCheckpoint()
    let protectedRecording = true
    let warnings = 0
    const cleanup = installRecordingNavigationGuard(() => protectedRecording, () => { warnings++ })
    if (requestRecordingExit()) throw new Error('Programmatic exits must respect the protected recording')
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    if (!unload.defaultPrevented) throw new Error('Closing a protected recording must request a browser warning')
    const recordingURL = location.href
    history.pushState(null, '', '/leave-recording')
    window.dispatchEvent(new PopStateEvent('popstate'))
    if (location.href !== recordingURL) throw new Error('History navigation did not restore the recorder URL')
    warnings = 0
    const anchor = document.createElement('a')
    anchor.href = '/leave-recording'
    document.body.append(anchor)
    const navigate = new MouseEvent('click', { bubbles: true, cancelable: true })
    anchor.dispatchEvent(navigate)
    if (!navigate.defaultPrevented || warnings !== 1)
      throw new Error('Navigation must not silently abandon an active or unsaved recording')
    protectedRecording = false
    // Observe the unlocked event but prevent the test page actually leaving.
    let unlocked = false
    anchor.addEventListener('click', (event) => {
      unlocked = !event.defaultPrevented
      event.preventDefault()
    })
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    cleanup()
    anchor.remove()
    if (!unlocked) throw new Error('Navigation stayed locked after the recording was safely saved')
    output.textContent = 'PASS: transaction rollback, committed recovery, failed-save retention, stable retry identity, account isolation, HTTP 401/422 retention, offline handoff, and click/history/unload/logout protection.'
  }
  catch (error) {
    output.textContent = `FAIL: ${error instanceof Error ? error.message : error}`
  }
  finally {
    run.removeAttribute('disabled')
  }
})

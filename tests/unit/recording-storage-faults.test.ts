import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { createIndexedDB, IDBObjectStore } from 'very-happy-dom'

/**
 * A recording must never be told it is safe before the write that makes it so
 * has committed.
 *
 * These ran in a real browser, which was the point: the database had to roll
 * back its own persisted write rather than a fake one agreeing to. `very-happy-dom`
 * keeps that property — its transactions snapshot each store and restore it on
 * `abort()` — so the failure can be forced here instead, with no browser and no
 * server. What is asserted is this app's behaviour around a refused write, which
 * is what the browser test was reading through the page.
 *
 * The fault is injected the same way: let the put succeed, then abort the
 * transaction from its own success handler.
 *
 * The database is put on the global and taken off again afterwards. Every file
 * shares one process, and other suites assert what this app does when device
 * storage is *unavailable* — leaving `indexedDB` behind made two of them fail,
 * because storage was suddenly available to them.
 */

const queue = 'run-uploads'
const checkpoints = 'recording-checkpoints'

let enqueueRun: any
let queuedRuns: any
let removeQueuedRun: any
let queuedRunDisposition: any
let loadRecordingCheckpoint: any
let saveRecordingCheckpoint: any
let clearRecordingCheckpoint: any
let saveFinishedRecording: any

const USER = 700001

function payloadFor(uploadId: string) {
  return {
    user_id: USER,
    activity_type: 'Hike',
    distance: 1,
    duration: '20:00',
    upload_id: uploadId,
    moving_time: '18:00',
    visibility: 'private',
    completed_at: '2026-09-24T01:00:00.000Z',
    gpx_data: JSON.stringify({ type: 'LineString', coordinates: [[-118.49, 34.01], [-118.49, 34.01001]] }),
    splits: [{ mile: 1, pace: '18:00', elev: 2 }],
  } as any
}

function checkpointFor(paused: boolean) {
  return {
    userId: USER,
    activityType: 'Hike' as const,
    visibility: 'private',
    runMode: 'free' as const,
    targetTerritoryId: null,
    startedAtMs: 1000,
    elapsed: 10,
    distance: 0.01,
    elevation: 0,
    paused,
    samples: [],
  }
}

/** Let the write succeed, then abort its transaction, as a failing disk would. */
async function whileStoreFails<T>(store: string, action: () => Promise<T>): Promise<{ rejected: boolean, result?: T }> {
  const original = IDBObjectStore.prototype.put
  ;(IDBObjectStore.prototype as any).put = function (...args: any[]) {
    const request = (original as any).apply(this, args)
    if (this.name === store)
      request.addEventListener('success', () => this.transaction.abort())
    return request
  }
  try {
    return { rejected: false, result: await action() }
  }
  catch {
    return { rejected: true }
  }
  finally {
    ;(IDBObjectStore.prototype as any).put = original
  }
}

beforeAll(async () => {
  const globals = globalThis as any
  globals.indexedDB = createIndexedDB()
  globals.IDBObjectStore = IDBObjectStore
  // Imported after the globals exist: the queue reads `indexedDB` on first use
  // and treats its absence as "no storage here".
  const uploads = await import('../../resources/assets/scripts/run-upload-queue')
  enqueueRun = uploads.enqueueRun
  queuedRuns = uploads.queuedRuns
  removeQueuedRun = uploads.removeQueuedRun
  queuedRunDisposition = uploads.queuedRunDisposition
  const checkpoint = await import('../../resources/assets/scripts/recording-checkpoint')
  loadRecordingCheckpoint = checkpoint.loadRecordingCheckpoint
  saveRecordingCheckpoint = checkpoint.saveRecordingCheckpoint
  clearRecordingCheckpoint = checkpoint.clearRecordingCheckpoint
  saveFinishedRecording = (await import('../../resources/assets/scripts/finished-recording')).saveFinishedRecording
})

afterAll(() => {
  const globals = globalThis as any
  delete globals.indexedDB
  delete globals.IDBObjectStore
})

afterEach(async () => {
  for (const row of await queuedRuns(USER))
    await removeQueuedRun(row.uploadId)
  await clearRecordingCheckpoint()
})

describe('a queued upload', () => {
  it('is recoverable once it has committed', async () => {
    await enqueueRun(payloadFor('committed'))

    const rows = await queuedRuns(USER)
    expect(rows.map((row: any) => row.uploadId)).toEqual(['committed'])
  })

  it('is not left behind by a write the database rolled back', async () => {
    const { rejected } = await whileStoreFails(queue, () => enqueueRun(payloadFor('rolled-back')))

    expect(rejected, 'enqueuing must reject when its transaction aborts').toBe(true)
    // The write must be gone, not merely unacknowledged: a row left here is a
    // recording the app would later upload twice.
    expect(await queuedRuns(USER)).toEqual([])
  })
})

describe('a recovery checkpoint', () => {
  it('is not promised before it has committed', async () => {
    const { rejected } = await whileStoreFails(checkpoints, () => saveRecordingCheckpoint(checkpointFor(false)))

    expect(rejected, 'saving must reject when its transaction aborts').toBe(true)
    expect(await loadRecordingCheckpoint(), 'recovery must never be promised before commit').toBeFalsy()
  })

  it('keeps a finished recording, and its retry identity, when the queue refuses it', async () => {
    const payload = payloadFor('kept-for-retry')
    const { rejected } = await whileStoreFails(queue, () => saveFinishedRecording(checkpointFor(true), payload))

    expect(rejected, 'finishing must reject when the queue write aborts').toBe(true)
    const pending = await loadRecordingCheckpoint()
    expect(pending?.pendingUpload?.upload_id, 'the finished recording and its identity survive').toBe('kept-for-retry')
  })

  it('hands the recording to the queue on a retry that commits, under the same identity', async () => {
    const payload = payloadFor('retried-once')
    await whileStoreFails(queue, () => saveFinishedRecording(checkpointFor(true), payload))
    const pending = await loadRecordingCheckpoint()

    const retried = await saveFinishedRecording(checkpointFor(true), pending!.pendingUpload)

    expect(retried.queued, 'a committed retry is queued').toBe(true)
    expect(await loadRecordingCheckpoint(), 'and leaves the recovery checkpoint').toBeFalsy()
    const rows = await queuedRuns(USER)
    expect(rows.map((row: any) => row.payload.upload_id), 'with the identity it already had').toEqual(['retried-once'])
  })
})

describe('what the queue does with a row it has tried', () => {
  it('is ready when nothing has gone wrong', () => {
    expect(queuedRunDisposition({ attempts: 1, nextAttemptAt: undefined })).toBe('ready')
  })

  it('defers a row whose next attempt is still in the future', () => {
    const later = new Date(Date.now() + 60_000).toISOString()
    expect(queuedRunDisposition({ attempts: 1, nextAttemptAt: later })).toBe('deferred')
    // And is ready again once that time has passed, rather than deferred for good.
    expect(queuedRunDisposition({ attempts: 1, nextAttemptAt: later }, Date.now() + 120_000)).toBe('ready')
  })

  it('gives up on a row the server refused outright', () => {
    expect(queuedRunDisposition({ attempts: 1, nextAttemptAt: undefined, failedAt: new Date().toISOString() })).toBe('failed')
  })
})

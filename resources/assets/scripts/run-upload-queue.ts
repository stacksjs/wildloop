import type { ActivityPayload, RunResult } from './game-api'

const DATABASE_NAME = 'wildloop-offline'
const STORE_NAME = 'run-uploads'
export const MAX_UPLOAD_ATTEMPTS = 8
const BASE_RETRY_DELAY_MS = 30_000
const MAX_RETRY_DELAY_MS = 24 * 60 * 60 * 1000

export interface QueuedRun {
  uploadId: string
  ownerId: number
  payload: ActivityPayload
  queuedAt: string
  attempts: number
  lastError: string | null
  nextAttemptAt: string
  failedAt: string | null
}

export function nextUploadDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1))
}

export function queuedRunDisposition(row: Pick<QueuedRun, 'attempts' | 'nextAttemptAt'> & Partial<Pick<QueuedRun, 'failedAt'>>, now = Date.now()): 'ready' | 'deferred' | 'failed' {
  if (row.failedAt || (row.attempts ?? 0) >= MAX_UPLOAD_ATTEMPTS) return 'failed'
  if (row.nextAttemptAt && Date.parse(row.nextAttemptAt) > now) return 'deferred'
  return 'ready'
}

export function uploadNeedsAttention(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status
  return !!status && status >= 400 && status < 500 && ![401, 408, 429].includes(status)
}

function notifyQueueChanged() {
  if (typeof globalThis.dispatchEvent === 'function')
    globalThis.dispatchEvent(new Event('wildloop:uploads-changed'))
}

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined')
    return Promise.resolve(null)

  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 3)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME))
        database.createObjectStore(STORE_NAME, { keyPath: 'uploadId' })
      if (!database.objectStoreNames.contains('trail-routes'))
        database.createObjectStore('trail-routes', { keyPath: 'id' })
      if (!database.objectStoreNames.contains('recording-checkpoints'))
        database.createObjectStore('recording-checkpoints', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T | null> {
  const database = await openDatabase()
  if (!database && mode === 'readwrite')
    throw new Error('Device storage is unavailable. Keep this page open and retry saving when connected.')
  if (!database)
    return null
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode)
    const request = operation(transaction.objectStore(STORE_NAME))
    request.onerror = () => reject(request.error)
    // A successful request can still be rolled back. Only the transaction
    // commit is evidence that a recording will survive closing this page.
    transaction.oncomplete = () => {
      database.close()
      resolve(request.result)
    }
    transaction.onabort = transaction.onerror = () => {
      database.close()
      reject(transaction.error ?? new Error('Device storage could not save the recording. Keep this page open and retry.'))
    }
  })
}

/**
 * The attempt count after a failed upload. A 401 says the session ended, not
 * that anything is wrong with the run. Counting it let a device left signed
 * out for a few days use up every attempt, after which the run was never
 * tried again, even once its owner signed back in.
 */
export function nextAttemptCount(previous: number, error: unknown): number {
  const sessionEnded = (error as { status?: number } | null)?.status === 401
  return previous + (sessionEnded ? 0 : 1)
}

export async function enqueueRun(payload: ActivityPayload, error: unknown = null, now = Date.now()): Promise<void> {
  if (!payload.upload_id)
    throw new Error('Queued runs require an upload_id')
  const existing = await withStore<QueuedRun>('readonly', store => store.get(payload.upload_id!))
  if (existing && existing.ownerId !== payload.user_id)
    throw new Error('Sign in to the account that recorded this activity.')
  const attempts = nextAttemptCount(existing?.attempts ?? 0, error)
  const queued: QueuedRun = {
    uploadId: payload.upload_id,
    ownerId: payload.user_id,
    payload,
    queuedAt: existing?.queuedAt ?? new Date(now).toISOString(),
    attempts,
    lastError: error instanceof Error ? error.message : error ? String(error) : null,
    nextAttemptAt: new Date(now + nextUploadDelayMs(attempts)).toISOString(),
    failedAt: uploadNeedsAttention(error) || attempts >= MAX_UPLOAD_ATTEMPTS ? new Date(now).toISOString() : null,
  }
  await withStore('readwrite', store => store.put(queued))
  notifyQueueChanged()
}

export async function queuedRuns(ownerId?: number): Promise<QueuedRun[]> {
  const rows = await withStore<QueuedRun[]>('readonly', store => store.getAll())
  const all = rows ?? []
  return (ownerId ? all.filter(row => row.ownerId === ownerId) : all)
    .sort((left, right) => left.queuedAt.localeCompare(right.queuedAt))
}

export async function removeQueuedRun(uploadId: string): Promise<void> {
  await withStore('readwrite', store => store.delete(uploadId))
  notifyQueueChanged()
}

/** Explicit recovery only. Keep the original payload and idempotency key. */
export async function retryQueuedRun(ownerId: number, uploadId: string): Promise<void> {
  const database = await openDatabase()
  if (!database) throw new Error('Device storage is unavailable.')
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    const request = store.get(uploadId)
    let failure: Error | null = null
    request.onsuccess = () => {
      const row = request.result as QueuedRun | undefined
      if (!ownerId || !row || row.ownerId !== ownerId) {
        failure = new Error('Sign in to the account that recorded this activity.')
        transaction.abort()
        return
      }
      store.put({ ...row, attempts: 0, failedAt: null, nextAttemptAt: new Date().toISOString() })
    }
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onabort = transaction.onerror = () => {
      database.close()
      reject(failure ?? transaction.error ?? new Error('Could not retry this recording.'))
    }
  })
  notifyQueueChanged()
  if (typeof globalThis.dispatchEvent === 'function')
    globalThis.dispatchEvent(new Event('wildloop:retry-uploads'))
}

/** Lossless local backup, including timestamps and the original GPS payload. */
export async function exportQueuedRun(ownerId: number, uploadId: string): Promise<string> {
  const row = await withStore<QueuedRun>('readonly', store => store.get(uploadId))
  if (!ownerId || !row || row.ownerId !== ownerId)
    throw new Error('Sign in to the account that recorded this activity.')
  return JSON.stringify({ format: 'wildloop-recording-v1', recording: row }, null, 2)
}

export async function flushQueuedRuns(
  ownerId: number,
  upload: (payload: ActivityPayload) => Promise<RunResult>,
  now = Date.now(),
): Promise<{ uploaded: number, remaining: number, deferred: number, failed: number }> {
  const rows = await queuedRuns(ownerId)
  let uploaded = 0
  let deferred = 0
  for (const row of rows) {
    const disposition = queuedRunDisposition(row, now)
    if (disposition === 'failed') continue
    if (disposition === 'deferred') {
      deferred++
      continue
    }
    try {
      const result = await upload(row.payload)
      if (result.activityId) {
        await removeQueuedRun(row.uploadId)
        uploaded++
      }
      else {
        await enqueueRun(row.payload, result.error || 'The server did not accept this activity', now)
      }
    }
    catch (error) {
      await enqueueRun(row.payload, error, now)
    }
  }
  const remainingRows = await queuedRuns(ownerId)
  return {
    uploaded,
    remaining: remainingRows.length,
    deferred,
    failed: remainingRows.filter(row => queuedRunDisposition(row, now) === 'failed').length,
  }
}

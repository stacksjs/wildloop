import type { RecorderSample } from '../../functions/splits'

const DATABASE_NAME = 'wildloop-offline'
const DATABASE_VERSION = 3
const STORE_NAME = 'recording-checkpoints'
const ACTIVE_RECORDING_ID = 'active'
export const RECORDING_CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface RecordingCheckpoint {
  id: typeof ACTIVE_RECORDING_ID
  activityType: 'Trail Run' | 'Hike' | 'Walk' | 'Bike'
  visibility: string
  runMode: 'capture' | 'free'
  targetTerritoryId: number | null
  startedAtMs: number
  elapsed: number
  distance: number
  elevation: number
  paused: boolean
  samples: RecorderSample[]
  savedAt: number
}

export interface NativeLocationSample {
  latitude: number
  longitude: number
  altitude?: number
  accuracy: number
  timestamp: number
}

function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('run-uploads')) db.createObjectStore('run-uploads', { keyPath: 'uploadId' })
      if (!db.objectStoreNames.contains('trail-routes')) db.createObjectStore('trail-routes', { keyPath: 'id' })
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function request<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await database()
  if (!db) return null
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode)
    const result = operation(transaction.objectStore(STORE_NAME))
    result.onsuccess = () => resolve(result.result)
    result.onerror = () => reject(result.error)
    transaction.oncomplete = () => db.close()
    transaction.onabort = () => db.close()
    transaction.onerror = () => db.close()
  })
}

export async function saveRecordingCheckpoint(checkpoint: Omit<RecordingCheckpoint, 'id' | 'savedAt'>): Promise<void> {
  await request('readwrite', store => store.put({
    ...checkpoint,
    id: ACTIVE_RECORDING_ID,
    savedAt: Date.now(),
  } satisfies RecordingCheckpoint))
}

export async function loadRecordingCheckpoint(): Promise<RecordingCheckpoint | null> {
  return await request<RecordingCheckpoint>('readonly', store => store.get(ACTIVE_RECORDING_ID))
}

export async function clearRecordingCheckpoint(): Promise<void> {
  await request('readwrite', store => store.delete(ACTIVE_RECORDING_ID))
}

/** A future timestamp is retained so a device clock correction cannot discard a live run. */
export function isRecordingCheckpointStale(checkpoint: Pick<RecordingCheckpoint, 'savedAt'>, now = Date.now()): boolean {
  return now - checkpoint.savedAt > RECORDING_CHECKPOINT_MAX_AGE_MS
}

function sampleKey(sample: Pick<RecorderSample, 'lat' | 'lng' | 't'>): string {
  return `${Math.round(sample.t)}:${sample.lat.toFixed(6)}:${sample.lng.toFixed(6)}`
}

/** Merge native background samples without double-counting foreground fixes. */
export function mergeNativeLocationSamples(current: RecorderSample[], native: NativeLocationSample[]): RecorderSample[] {
  const merged = [...current]
  const seen = new Set(merged.map(sampleKey))
  for (const location of native) {
    const sample: RecorderSample = {
      lat: location.latitude,
      lng: location.longitude,
      t: location.timestamp,
      eleFt: location.altitude == null ? null : location.altitude * 3.28084,
      movingS: 0,
      accuracy: location.accuracy,
    }
    const key = sampleKey(sample)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(sample)
  }
  merged.sort((left, right) => left.t - right.t)
  return merged
}

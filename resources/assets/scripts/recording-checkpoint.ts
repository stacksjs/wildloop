import type { RecorderSample } from '../../functions/splits'

const DATABASE_NAME = 'wildloop-offline'
const DATABASE_VERSION = 3
const STORE_NAME = 'recording-checkpoints'
const ACTIVE_RECORDING_ID = 'active'
export const RECORDING_CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface RecordingCheckpoint {
  id: typeof ACTIVE_RECORDING_ID
  /** The authenticated account that started this device-level native recording. */
  userId: number
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

/**
 * Checkpoints and native recording state are device-level, while activities
 * belong to an account. Never restore or replace a checkpoint unless it was
 * created by the active authenticated account.
 */
export function ownsRecordingCheckpoint(checkpoint: Pick<RecordingCheckpoint, 'userId'> | null, userId: number | null | undefined): boolean {
  return Number.isSafeInteger(userId) && Number(userId) > 0 && checkpoint?.userId === userId
}

/** A future timestamp is retained so a device clock correction cannot discard a live run. */
export function isRecordingCheckpointStale(checkpoint: Pick<RecordingCheckpoint, 'savedAt'>, now = Date.now()): boolean {
  return now - checkpoint.savedAt > RECORDING_CHECKPOINT_MAX_AGE_MS
}

function sampleKey(sample: Pick<RecorderSample, 'lat' | 'lng' | 't'>): string {
  return `${Math.round(sample.t)}:${sample.lat.toFixed(6)}:${sample.lng.toFixed(6)}`
}

function isValidNativeLocationSample(sample: NativeLocationSample): boolean {
  return Number.isFinite(sample.latitude)
    && Number.isFinite(sample.longitude)
    && Number.isFinite(sample.timestamp)
    && sample.timestamp > 0
    && sample.latitude >= -90
    && sample.latitude <= 90
    && sample.longitude >= -180
    && sample.longitude <= 180
}

/** Merge native background samples without double-counting foreground fixes. */
export function mergeNativeLocationSamples(current: RecorderSample[], native: NativeLocationSample[]): RecorderSample[] {
  const merged = [...current]
  const seen = new Set(merged.map(sampleKey))
  for (const location of native) {
    // A malformed bridge payload must never turn distance, elevation, or pace
    // into NaN. Ignore the bad point and retain the trustworthy route around it.
    if (!isValidNativeLocationSample(location)) continue
    const sample: RecorderSample = {
      lat: location.latitude,
      lng: location.longitude,
      t: location.timestamp,
      eleFt: Number.isFinite(location.altitude) ? location.altitude! * 3.28084 : null,
      movingS: 0,
      accuracy: Number.isFinite(location.accuracy) ? location.accuracy : null,
    }
    const key = sampleKey(sample)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(sample)
  }
  merged.sort((left, right) => left.t - right.t)
  return merged
}

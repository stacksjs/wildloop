import type { LatLng, UiTrail } from './trail-data'
import { resolveVectorTiles } from '../../composables/useTrailMap'

const DATABASE_NAME = 'wildloop-offline'
const STORE_NAME = 'trail-routes'

export interface OfflineTrail {
  id: number
  trail: UiTrail
  route: LatLng[]
  savedAt: string
  tiles?: { saved: number, failed: number, skipped: number }
}

function database(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 3)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('run-uploads')) db.createObjectStore('run-uploads', { keyPath: 'uploadId' })
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: 'id' })
      if (!db.objectStoreNames.contains('recording-checkpoints')) db.createObjectStore('recording-checkpoints', { keyPath: 'id' })
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
  })
}

export async function saveTrailOffline(trail: UiTrail, route: LatLng[]): Promise<void> {
  if (route.length < 2) throw new Error('This trail has no verified route geometry to download')
  let tiles: OfflineTrail['tiles']
  try {
    const mapsModuleUrl = '/js/ts-maps.mjs'
    const module = await import(/* @vite-ignore */ mapsModuleUrl) as typeof import('ts-maps')
    // The tiles the basemap actually requests, which is the point: this used to
    // pre-fetch raster OpenStreetMap images, and once the map moved to vector
    // tiles nothing ever read them back. A download that fills a cache the map
    // does not use is worse than no download — it reports success and then the
    // trail is blank in the field.
    const tileUrl = await resolveVectorTiles()
    if (!tileUrl)
      throw new Error('basemap tile URL unavailable')
    const latitudes = route.map(point => point[0])
    const longitudes = route.map(point => point[1])
    const padding = 0.01
    tiles = await module.saveOfflineRegion({
      bounds: [
        Math.min(...longitudes) - padding,
        Math.min(...latitudes) - padding,
        Math.max(...longitudes) + padding,
        Math.max(...latitudes) + padding,
      ],
      // The vector source publishes to z14 and the renderer subdivides above
      // it, so z14 is the deepest level worth storing — everything past it is
      // drawn from these same tiles.
      zoomRange: [10, 14],
      tileUrl,
      concurrency: 4,
    })
  }
  catch (error) {
    console.warn('Offline basemap download failed; route geometry remains available', error)
  }
  await request('readwrite', store => store.put({ id: trail.id, trail, route, tiles, savedAt: new Date().toISOString() }))
}

export async function removeOfflineTrail(id: number): Promise<void> {
  await request('readwrite', store => store.delete(id))
}

export async function offlineTrail(id: number): Promise<OfflineTrail | null> {
  return await request<OfflineTrail>('readonly', store => store.get(id))
}

export async function isTrailOffline(id: number): Promise<boolean> {
  return !!await offlineTrail(id)
}

/**
 * Every downloaded trail's id, in one read.
 *
 * A list of sixty cards each asking `isTrailOffline` is sixty transactions to
 * answer a question one `getAllKeys` answers, and the download badge has to be
 * right on first paint rather than sixty promises later.
 */
export async function offlineTrailIds(): Promise<number[]> {
  const keys = await request<IDBValidKey[]>('readonly', store => store.getAllKeys())
  return (keys ?? []).map(Number).filter(Number.isFinite)
}

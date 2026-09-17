/**
 * Offline downloads, shared by every surface that offers one.
 *
 * The trail page already knew how to save a route for the field; a card in a
 * list did not, so planning a weekend meant opening each trail in turn to get
 * it onto the phone. The state lives here rather than in either page so the
 * two cannot disagree about what is downloaded.
 */

import type { LatLng, UiTrail } from '../assets/scripts/trail-data'
import { state } from 'stx'
import { offlineTrailIds, removeOfflineTrail, saveTrailOffline } from '../assets/scripts/offline-trails'

/** Ids of every trail held offline. Read once, then kept in step with writes. */
export const downloadedTrailIds = state<number[]>([])

/** The trail a download is running for, so its button can say so. 0 when idle. */
export const downloadingTrailId = state(0)

/** The last thing that happened, for a toast or an inline line. */
export const downloadMessage = state<string | null>(null)

export function isTrailDownloaded(id: number): boolean {
  return downloadedTrailIds().includes(id)
}

export async function refreshDownloads(): Promise<void> {
  try {
    downloadedTrailIds.set(await offlineTrailIds())
  }
  catch {
    // A browser with IndexedDB blocked has no downloads, which is the same
    // thing an empty list says. Nothing to report.
    downloadedTrailIds.set([])
  }
}

function markDownloaded(id: number, downloaded: boolean): void {
  const ids = downloadedTrailIds().filter(value => value !== id)
  downloadedTrailIds.set(downloaded ? [...ids, id] : ids)
}

/**
 * Download a trail, or drop the copy already held.
 *
 * Returns whether the trail is offline afterwards, so a caller that tracks its
 * own per-page flag does not have to re-read the store.
 */
export async function toggleDownload(trail: UiTrail | null, route: LatLng[] | undefined): Promise<boolean> {
  if (!trail)
    return false

  const held = isTrailDownloaded(trail.id)
  downloadingTrailId.set(trail.id)
  downloadMessage.set(null)

  try {
    if (held) {
      await removeOfflineTrail(trail.id)
      markDownloaded(trail.id, false)
      downloadMessage.set(`${trail.name} removed from offline.`)
      return false
    }

    await saveTrailOffline(trail, route ?? [])
    markDownloaded(trail.id, true)
    downloadMessage.set(`${trail.name} saved for offline use.`)
    return true
  }
  catch (error) {
    // The common failure is a trail with no recorded line, and saying that is
    // more useful than a button that appears to do nothing.
    downloadMessage.set(error instanceof Error ? error.message : 'Could not save this trail offline')
    return held
  }
  finally {
    downloadingTrailId.set(0)
  }
}

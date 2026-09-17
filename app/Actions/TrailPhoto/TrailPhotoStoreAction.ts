// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports.
//
// POST /api/trails/{id}/photos with a multipart field `photo`.
//
// The upload is re-encoded before anything is stored (see
// app/Support/trailPhotoProcessing.ts), which is what removes its GPS
// position. Nothing from the original file is ever written.

import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { photoKeys, photoStorage, PhotoStorageNotConfiguredError } from '../../Support/photoStorage'
import { toTrailPhotoPayload } from '../../Support/trailPhotoPayload'
import { PhotoRejectedError, processTrailPhoto } from '../../Support/trailPhotoProcessing'

/** Enough for a real day on a trail, not enough to use a trail as file hosting. */
const MAX_PHOTOS_PER_USER_PER_TRAIL = 30

export default new Action({
  name: 'Trail Photo Store',
  description: 'Add a photo to a trail',
  method: 'POST',

  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user?.id)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const trailId = Number(request.get('id'))
    if (!Number.isInteger(trailId) || trailId <= 0)
      return response.json({ success: false, error: 'Trail not found' }, 404)

    const trail = (await db.sql`SELECT id FROM trails WHERE id = ${trailId}`.execute() as any[])[0]
    if (!trail)
      return response.json({ success: false, error: 'Trail not found' }, 404)

    const existing = (await db.sql`SELECT count(*) AS n FROM trail_photos WHERE trail_id = ${trailId} AND user_id = ${user.id}`.execute() as any[])[0]
    if (Number(existing?.n ?? 0) >= MAX_PHOTOS_PER_USER_PER_TRAIL)
      return response.json({ success: false, error: `You can add up to ${MAX_PHOTOS_PER_USER_PER_TRAIL} photos to a trail.` }, 422)

    const file = request.file('photo') as { bytes?: () => Promise<Uint8Array>, arrayBuffer?: () => Promise<ArrayBuffer> } | null
    if (!file)
      return response.json({ success: false, error: 'Choose a photo to upload.', fields: { photo: 'Choose a photo to upload.' } }, 422)

    let processed
    try {
      const bytes = file.bytes ? await file.bytes() : new Uint8Array(await file.arrayBuffer!())
      processed = await processTrailPhoto(bytes)
    }
    catch (error) {
      if (error instanceof PhotoRejectedError)
        return response.json({ success: false, error: error.message, reason: error.reason, fields: { photo: error.message } }, 422)
      throw error
    }

    let store
    try {
      store = photoStorage()
    }
    catch (error) {
      if (error instanceof PhotoStorageNotConfiguredError) {
        console.error('[photos]', error.message)
        return response.json({ success: false, error: 'Photo uploads are not available right now.' }, 503)
      }
      throw error
    }

    const uuid = crypto.randomUUID()
    const keys = photoKeys(trailId, uuid)
    try {
      await store.write(keys.display, processed.display)
      await store.write(keys.thumb, processed.thumb)
    }
    catch (error) {
      // Leave nothing half-stored: a row is only written once both files exist.
      await store.deleteFile(keys.display).catch(() => {})
      await store.deleteFile(keys.thumb).catch(() => {})
      console.error('[photos] storage write failed', error)
      return response.json({ success: false, error: 'The photo could not be saved. Please try again.' }, 502)
    }

    const bytes = processed.display.length + processed.thumb.length
    try {
      await db.sql`
        INSERT INTO trail_photos (uuid, trail_id, user_id, storage_key, thumb_key, width, height, bytes, created_at, updated_at)
        VALUES (${uuid}, ${trailId}, ${user.id}, ${keys.display}, ${keys.thumb}, ${processed.width}, ${processed.height}, ${bytes}, ${new Date().toISOString()}, ${new Date().toISOString()})
      `.execute()
    }
    catch (error) {
      await store.deleteFile(keys.display).catch(() => {})
      await store.deleteFile(keys.thumb).catch(() => {})
      throw error
    }

    const row = (await db.sql`
      SELECT p.uuid, p.trail_id, p.user_id, p.width, p.height, p.created_at, u.name AS user_name
      FROM trail_photos p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.uuid = ${uuid}
    `.execute() as any[])[0]

    return response.json({ success: true, photo: toTrailPhotoPayload(row, Number(user.id)) }, 201)
  },
})

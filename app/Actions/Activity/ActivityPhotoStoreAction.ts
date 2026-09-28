// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports.
//
// POST /api/activities/{id}/photos with a multipart field `photo`.
//
// The upload is re-encoded before anything is stored (app/Support/
// trailPhotoProcessing.ts), which is what removes its GPS position. That
// matters more here than on a trail photo: a trail is already a public place
// with published coordinates, while the photos on a run describe where one
// person was on a particular afternoon. Nothing from the original file is
// ever written.

import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { toActivityPhotoPayload } from '../../Support/activityPhotoPayload'
import { activityPhotoKeys, photoStorage, PhotoStorageNotConfiguredError } from '../../Support/photoStorage'
import { PhotoRejectedError, processPhoto } from '../../Support/trailPhotoProcessing'

/** Enough for a long day out, not enough to use an activity as file hosting. */
const MAX_PHOTOS_PER_ACTIVITY = 20

export default new Action({
  name: 'Activity Photo Store',
  description: 'Add a photo to an activity',
  method: 'POST',

  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user?.id)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const activityId = Number(request.get('id'))
    if (!Number.isInteger(activityId) || activityId <= 0)
      return response.json({ success: false, error: 'Activity not found' }, 404)

    // Ownership, not just existence, and it is the whole difference from a
    // trail photo. Anyone may add a picture to a trail; an activity is one
    // person's account of their own afternoon, and nobody else gets to add to
    // it. A stranger is told the same "not found" as for an activity that does
    // not exist, so this cannot be used to discover which ids are real.
    const activity = (await db.sql`
      SELECT id, user_id FROM activities WHERE id = ${activityId}
    `.execute() as any[])[0]
    if (!activity || Number(activity.user_id) !== Number(user.id))
      return response.json({ success: false, error: 'Activity not found' }, 404)

    const existing = (await db.sql`
      SELECT count(*) AS n FROM activity_photos WHERE activity_id = ${activityId}
    `.execute() as any[])[0]
    if (Number(existing?.n ?? 0) >= MAX_PHOTOS_PER_ACTIVITY)
      return response.json({ success: false, error: `You can add up to ${MAX_PHOTOS_PER_ACTIVITY} photos to an activity.` }, 422)

    // Before any processing: an upload that cannot be stored should not cost
    // half a second of decoding first.
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

    const file = request.file('photo') as { bytes?: () => Promise<Uint8Array>, arrayBuffer?: () => Promise<ArrayBuffer> } | null
    if (!file)
      return response.json({ success: false, error: 'Choose a photo to upload.', fields: { photo: 'Choose a photo to upload.' } }, 422)

    let processed
    try {
      const bytes = file.bytes ? await file.bytes() : new Uint8Array(await file.arrayBuffer!())
      processed = await processPhoto(bytes)
    }
    catch (error) {
      if (error instanceof PhotoRejectedError)
        return response.json({ success: false, error: error.message, reason: error.reason, fields: { photo: error.message } }, 422)
      throw error
    }

    const uuid = crypto.randomUUID()
    const keys = activityPhotoKeys(activityId, uuid)
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

    // Appended rather than numbered from the count, so deleting the third of
    // four does not give the next upload a position something already holds.
    const last = (await db.sql`
      SELECT COALESCE(MAX(position), -1) AS p FROM activity_photos WHERE activity_id = ${activityId}
    `.execute() as any[])[0]
    const position = Number(last?.p ?? -1) + 1

    const bytes = processed.display.length + processed.thumb.length
    const now = new Date().toISOString()
    try {
      await db.sql`
        INSERT INTO activity_photos (uuid, activity_id, user_id, storage_key, thumb_key, width, height, bytes, position, created_at, updated_at)
        VALUES (${uuid}, ${activityId}, ${user.id}, ${keys.display}, ${keys.thumb}, ${processed.width}, ${processed.height}, ${bytes}, ${position}, ${now}, ${now})
      `.execute()
    }
    catch (error) {
      await store.deleteFile(keys.display).catch(() => {})
      await store.deleteFile(keys.thumb).catch(() => {})
      throw error
    }

    const row = (await db.sql`
      SELECT uuid, activity_id, user_id, width, height, position, created_at
      FROM activity_photos WHERE uuid = ${uuid}
    `.execute() as any[])[0]

    return response.json({ success: true, photo: toActivityPhotoPayload(row, Number(user.id)) }, 201)
  },
})

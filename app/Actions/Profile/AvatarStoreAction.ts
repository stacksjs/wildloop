// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports.
//
// POST /api/me/avatar with a multipart field `avatar`.
//
// The upload is re-encoded and cropped square before anything is stored (see
// app/Support/avatarProcessing.ts), which is what removes its EXIF and GPS
// position. Nothing from the original file is ever written. The photo it
// replaces is deleted once the new one is in place.

import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { processAvatar } from '../../Support/avatarProcessing'
import { deleteAvatarFiles, writeAvatarFiles } from '../../Support/avatars'
import { photoStorage, PhotoStorageNotConfiguredError } from '../../Support/photoStorage'
import { PhotoRejectedError } from '../../Support/trailPhotoProcessing'
import { profileResponse, userRow } from '../../Support/profileResponse'

export default new Action({
  name: 'Avatar Store',
  description: 'Set the signed-in athlete\'s profile photo',
  method: 'POST',

  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user?.id)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    const userId = Number(user.id)

    // Before any processing: an upload that cannot be stored should not cost
    // the decoding first.
    let store
    try {
      store = photoStorage()
    }
    catch (error) {
      if (error instanceof PhotoStorageNotConfiguredError) {
        console.error('[avatars]', error.message)
        return response.json({ success: false, error: 'Photo uploads are not available right now.' }, 503)
      }
      throw error
    }

    const file = request.file('avatar') as { bytes?: () => Promise<Uint8Array>, arrayBuffer?: () => Promise<ArrayBuffer> } | null
    if (!file)
      return response.json({ success: false, error: 'Choose a photo to upload.', fields: { avatar: 'Choose a photo to upload.' } }, 422)

    let processed
    try {
      const bytes = file.bytes ? await file.bytes() : new Uint8Array(await file.arrayBuffer!())
      processed = await processAvatar(bytes)
    }
    catch (error) {
      if (error instanceof PhotoRejectedError)
        return response.json({ success: false, error: error.message, reason: error.reason, fields: { avatar: error.message } }, 422)
      throw error
    }

    let avatar: string
    try {
      avatar = await writeAvatarFiles(store, userId, crypto.randomUUID(), processed)
    }
    catch (error) {
      console.error('[avatars] storage write failed', error)
      return response.json({ success: false, error: 'The photo could not be saved. Please try again.' }, 502)
    }

    // Read as late as possible, so the photo deleted below is the one this
    // upload actually replaced.
    const previous = (await userRow(userId))?.avatar ?? null
    try {
      await db.sql`UPDATE users SET avatar = ${avatar}, updated_at = ${new Date().toISOString()} WHERE id = ${userId}`.execute()
    }
    catch (error) {
      await deleteAvatarFiles(store, avatar)
      throw error
    }
    if (previous && previous !== avatar)
      await deleteAvatarFiles(store, previous)

    return profileResponse(userId, 201)
  },
})

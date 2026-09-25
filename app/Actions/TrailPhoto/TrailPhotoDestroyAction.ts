// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports.
//
// DELETE /api/trail-photos/{uuid}. The person who added the photo, or an admin.

import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { isAdminUser } from '../../Support/routeEfforts'
import { photoStorage } from '../../Support/photoStorage'

export default new Action({
  name: 'Trail Photo Destroy',
  description: 'Delete a trail photo',
  method: 'DELETE',

  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user?.id)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const uuid = String(request.get('uuid') ?? '')
    const photo = (await db.sql`
      SELECT id, user_id, storage_key, thumb_key FROM trail_photos WHERE uuid = ${uuid}
    `.execute() as any[])[0]
    if (!photo)
      return response.json({ success: false, error: 'Photo not found' }, 404)

    if (Number(photo.user_id) !== Number(user.id) && !await isAdminUser(Number(user.id)))
      return response.json({ success: false, error: 'You can only delete your own photos.' }, 403)

    // The row goes first: once it is gone the file route stops serving the
    // photo, even if removing the files below fails and has to be retried.
    await db.sql`DELETE FROM trail_photos WHERE id = ${photo.id}`.execute()
    const store = photoStorage()
    await store.deleteFile(photo.storage_key).catch((error: unknown) => console.error('[photos] could not delete', photo.storage_key, error))
    await store.deleteFile(photo.thumb_key).catch((error: unknown) => console.error('[photos] could not delete', photo.thumb_key, error))

    return response.json({ success: true })
  },
})

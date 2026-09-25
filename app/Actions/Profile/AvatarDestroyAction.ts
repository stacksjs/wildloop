// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports.
//
// DELETE /api/me/avatar - go back to the initial. The files go with it, and
// the file route stops serving them at once, because it only answers for the
// photo a user's row points at.

import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { deleteAvatarFiles } from '../../Support/avatars'
import { photoStorage } from '../../Support/photoStorage'
import { profileResponse, userRow } from '../../Support/profileResponse'

export default new Action({
  name: 'Avatar Destroy',
  description: 'Remove the signed-in athlete\'s profile photo',
  method: 'DELETE',

  async handle() {
    const user = await Auth.user().catch(() => null)
    if (!user?.id)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    const userId = Number(user.id)

    const previous = (await userRow(userId))?.avatar ?? null
    await db.sql`UPDATE users SET avatar = NULL, updated_at = ${new Date().toISOString()} WHERE id = ${userId}`.execute()

    if (previous) {
      // The row no longer points at the photo, so it is already unreachable.
      // A store that is not configured only means the files stay behind.
      try {
        await deleteAvatarFiles(photoStorage(), previous)
      }
      catch (error) {
        console.error('[avatars] could not delete removed avatar files', error)
      }
    }

    return profileResponse(userId)
  },
})

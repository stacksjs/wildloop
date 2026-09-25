// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports.
//
// PUT /api/me/profile with { name, bio, location } - what the athlete says
// about themselves. Bio and location are optional: an empty one is cleared.

import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { validateProfileInput } from '../../../resources/functions/profile-form'
import { profileResponse } from '../../Support/profileResponse'

export default new Action({
  name: 'Profile Update',
  description: 'Update the signed-in athlete\'s name, bio and location',
  method: 'PUT',

  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user?.id)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    const userId = Number(user.id)

    const checked = validateProfileInput({
      name: request.get('name'),
      bio: request.get('bio'),
      location: request.get('location'),
    })
    if ('errors' in checked) {
      const first = Object.values(checked.errors)[0]
      return response.json({ success: false, error: first, fields: checked.errors }, 422)
    }

    const { name, bio, location } = checked.value
    await db.sql`
      UPDATE users SET name = ${name}, bio = ${bio}, location = ${location}, updated_at = ${new Date().toISOString()}
      WHERE id = ${userId}
    `.execute()

    return profileResponse(userId)
  },
})

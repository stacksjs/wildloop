import { Auth } from '@stacksjs/auth'

import DevicePushToken from '../../Models/DevicePushToken'

export default new Action({
  name: 'Unregister Push Token',
  description: 'Remove the authenticated user’s native notification token',
  method: 'DELETE',
  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const token = String(request.get('token') ?? '').trim()
    if (token.length < 16 || token.length > 4096)
      return response.json({ success: false, error: 'Validation failed', fields: { token: 'must be a valid native push token' } }, 422)

    // Token values are globally unique, but ownership remains part of the
    // lookup. A valid session may only remove its own device registration.
    const existing = await DevicePushToken
      .where('token', '=', token)
      .where('user_id', '=', user.id)
      .first()
    if (existing)
      await DevicePushToken.delete(existing.id)

    return response.json({ success: true })
  },
})

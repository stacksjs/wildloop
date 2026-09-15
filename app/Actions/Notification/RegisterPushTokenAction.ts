import { Auth } from '@stacksjs/auth'

import DevicePushToken from '../../Models/DevicePushToken'

const PLATFORMS = ['ios', 'android']
const ENVIRONMENTS = ['development', 'production']

export default new Action({
  name: 'Register Push Token',
  description: 'Associate a native notification token with the authenticated user',
  method: 'POST',
  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const token = String(request.get('token') ?? '').trim()
    const platform = String(request.get('platform') ?? '').trim()
    const environment = String(request.get('environment') ?? 'production').trim()
    const deviceId = String(request.get('device_id') ?? '').trim() || null
    const fields: Record<string, string> = {}
    if (token.length < 16 || token.length > 4096) fields.token = 'must be a valid native push token'
    if (!PLATFORMS.includes(platform)) fields.platform = 'must be ios or android'
    if (!ENVIRONMENTS.includes(environment)) fields.environment = 'must be development or production'
    if (deviceId && deviceId.length > 255) fields.device_id = 'must not exceed 255 characters'
    if (Object.keys(fields).length)
      return response.json({ success: false, error: 'Validation failed', fields }, 422)

    const values = {
      user_id: user.id,
      token,
      platform,
      device_id: deviceId,
      environment,
      last_seen_at: new Date().toISOString(),
    }
    const existing = await DevicePushToken.where('token', '=', token).first()
    // A device token must not become an account-switch primitive. The account
    // that registered it can remove it from Settings; another authenticated
    // account cannot silently redirect that device's notifications.
    if (existing && existing.user_id !== user.id)
      return response.json({ success: false, error: 'This device is registered to another account. Turn off notifications before switching accounts.' }, 409)
    const saved = existing
      ? await DevicePushToken.forceUpdate(existing.id, values)
      : await DevicePushToken.forceCreate(values)

    return response.json({ success: true, id: saved?.id })
  },
})

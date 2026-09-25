// GET /api/avatars/{userId}/{file}, where file is <uuid>.jpg or
// <uuid>-thumb.jpg. Public: faces show on public pages.
//
// The bucket is private, so every avatar is read through here. Only a key
// this app could have written is looked up, and only while it is the photo
// the user's row points at, so a replaced or removed photo stops being served
// straight away. The cache time matches trail photos (a day) for the same
// reason: Cloudflare caches responses, and a removed photo should not outlive
// its removal by long.

import { db } from '@stacksjs/orm'
import { isAvatarKey, storedAvatar } from '../../Support/avatars'
import { photoStorage } from '../../Support/photoStorage'

export default new Action({
  name: 'Avatar File',
  description: 'Serve a stored profile photo',
  method: 'GET',

  async handle(request) {
    const userId = String(request.get('userId') ?? '')
    const file = String(request.get('file') ?? '')
    const key = `avatars/${userId}/${file}`
    if (!isAvatarKey(key))
      return response.json({ success: false, error: 'Not found' }, 404)

    const row = (await db.sql`SELECT avatar FROM users WHERE id = ${Number(userId)}`.execute() as any[])[0]
    const current = storedAvatar(row?.avatar)
    const uuid = file.replace(/(-thumb)?\.jpg$/, '')
    if (!current || current.userId !== Number(userId) || current.uuid !== uuid)
      return response.json({ success: false, error: 'Not found' }, 404)

    let bytes: Uint8Array
    try {
      bytes = await photoStorage().readToUint8Array(key)
    }
    catch {
      return response.json({ success: false, error: 'Not found' }, 404)
    }

    return new Response(bytes as unknown as BodyInit, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
})

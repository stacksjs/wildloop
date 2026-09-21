// GET /api/trail-photos/{trailId}/{file}, where file is <uuid>.jpg or
// <uuid>-thumb.jpg. Public.
//
// The bucket is private, so every photo is read through here. Only a key this
// app could have written is looked up, and only while its photo is visible, so
// a hidden photo stops being served straight away. Cloudflare sits in front of
// wildloop.org and caches responses, which is why the cache time is a day and
// not a year: a photo hidden after a report should not outlive that by long.

import { db } from '@stacksjs/orm'
import { isPhotoKey, photoStorage } from '../../Support/photoStorage'

export default new Action({
  name: 'Trail Photo File',
  description: 'Serve a stored trail photo',
  method: 'GET',

  async handle(request) {
    const trailId = String(request.get('trailId') ?? '')
    const file = String(request.get('file') ?? '')
    const key = `trails/${trailId}/${file}`
    if (!isPhotoKey(key))
      return response.json({ success: false, error: 'Not found' }, 404)

    const uuid = file.replace(/(-thumb)?\.jpg$/, '')
    const visible = (await db.sql`
      SELECT 1 AS ok FROM trail_photos WHERE uuid = ${uuid} AND trail_id = ${Number(trailId)} AND status = 'visible'
    `.execute() as any[])[0]
    if (!visible)
      return response.json({ success: false, error: 'Not found' }, 404)

    let bytes: Uint8Array
    try {
      bytes = await photoStorage().readToUint8Array(key)
    }
    catch {
      return response.json({ success: false, error: 'Not found' }, 404)
    }

    return new Response(bytes, {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
})

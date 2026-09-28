// GET /api/activity-photos/{activityId}/{file}, where file is <uuid>.jpg or
// <uuid>-thumb.jpg. Public, because the feed is.
//
// The bucket is private, so every photo is read through here. Only a key this
// app could have written is looked up, and only while its photo is visible, so
// a hidden photo stops being served straight away. Cloudflare sits in front of
// wildloop.org and caches responses, which is why the cache time is a day and
// not a year: a photo hidden after the fact should not outlive that by long.

import { db } from '@stacksjs/orm'
import { isPhotoKey, photoStorage } from '../../Support/photoStorage'

export default new Action({
  name: 'Activity Photo File',
  description: 'Serve a stored activity photo',
  method: 'GET',

  async handle(request) {
    const activityId = String(request.get('activityId') ?? '')
    const file = String(request.get('file') ?? '')
    const key = `activities/${activityId}/${file}`
    if (!isPhotoKey(key))
      return response.json({ success: false, error: 'Not found' }, 404)

    const uuid = file.replace(/(-thumb)?\.jpg$/, '')
    const visible = (await db.sql`
      SELECT 1 AS ok FROM activity_photos WHERE uuid = ${uuid} AND activity_id = ${Number(activityId)} AND status = 'visible'
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

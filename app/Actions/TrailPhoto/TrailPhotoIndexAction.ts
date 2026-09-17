// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports.
//
// GET /api/trails/{id}/photos. Public. Visible photos only, newest first.

import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { toTrailPhotoPayload } from '../../Support/trailPhotoPayload'

const LIMIT = 60

export default new Action({
  name: 'Trail Photo Index',
  description: 'List the photos people have added to a trail',
  method: 'GET',

  async handle(request) {
    const trailId = Number(request.get('id'))
    if (!Number.isInteger(trailId) || trailId <= 0)
      return response.json({ success: false, error: 'Trail not found' }, 404)

    const viewer = await Auth.user().catch(() => null)
    const rows = await db.sql`
      SELECT p.uuid, p.trail_id, p.user_id, p.width, p.height, p.created_at, u.name AS user_name
      FROM trail_photos p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.trail_id = ${trailId} AND p.status = 'visible'
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT ${LIMIT}
    `.execute() as any[]

    return response.json({
      success: true,
      photos: (rows ?? []).map(row => toTrailPhotoPayload(row, viewer?.id ? Number(viewer.id) : null)),
    })
  },
})

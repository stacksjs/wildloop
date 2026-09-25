// Shared by the profile endpoints: reading the signed-in athlete's row fresh,
// and answering with it in the shape /api/me uses.

import { db } from '@stacksjs/orm'
import { response } from '@stacksjs/router'
import { sessionUserPayload } from './sessionUser'

export async function userRow(userId: number): Promise<Record<string, any> | null> {
  const rows = await db.sql`SELECT * FROM users WHERE id = ${userId}`.execute() as any[]
  return rows[0] ?? null
}

/** `{ success, user }` with the row as it now stands, for the client to adopt. */
export async function profileResponse(userId: number, status: 200 | 201 = 200): Promise<Response> {
  const row = await userRow(userId)
  if (!row)
    return response.json({ success: false, error: 'Authentication required' }, 401)
  const user = await sessionUserPayload(row)
  return response.json({ success: true, avatar: user.avatar, user }, status)
}

// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. `db` is imported the way
// the other raw-SQL actions import it; everything else here is auto-imported
// as usual.
//
// GET /api/users/search?q= - find athletes by name (#971). With a query of
// 2+ characters it's a case-insensitive LIKE search; with no/shorter query it
// returns the most active athletes as a discover list. Public read; response
// includes enough stats to render discover cards without extra calls.

import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { isNameSearch, searchAthletes } from '../../Support/athleteSearch'
import { athletesLivingNear, readOrigin } from '../../Support/athletesNear'

export default new Action({
  name: 'User Search',
  description: 'Search athletes by name (discover list when no query)',
  method: 'GET',

  async handle(request) {
    const qRaw = request.get<string>('q')
    const q = typeof qRaw === 'string' ? qRaw.trim() : ''

    try {
      const viewerId = (await Auth.user().catch(() => null))?.id ?? null
      const blockedIds = await blockedUserIdsFor(viewerId)
      const run = async (sql: string, params: unknown[] = []) => (await db.sql`${db.unsafe(sql, params)}`.execute() as any[]) ?? []

      // Discover mode can be asked from somewhere (`?lat=&lng=`, the same
      // coarse fix the catalog opens on). Athletes whose public profile town
      // is near it come first. Only a yes/no goes back: nobody's coordinates
      // or distance from the viewer leave the server.
      const from = isNameSearch(q) ? null : readOrigin(request)
      const near = from ? await athletesLivingNear(run, from) : null

      // Counted, ordered and paged in SQL (see athleteSearch), so meta.total
      // and hasMore are the real match count (#978) without loading every
      // athlete and every activity they ever recorded.
      const { athletes, meta } = await searchAthletes(run, {
        text: q,
        blocked: blockedIds,
        near,
        page: readPageParams(request, { defaultLimit: 20, maxLimit: 50 }),
      })
      return response.json({ success: true, athletes, meta: { ...meta, query: q } })
    }
    catch (error) {
      console.error('[users] search failed:', error)
      return response.json({ success: false, error: 'Failed to search users' }, 500)
    }
  },
})

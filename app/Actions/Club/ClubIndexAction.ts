// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. `db` is imported the way
// the other raw-SQL actions import it; the models and response helpers are
// auto-imported as usual.
//
// GET /api/clubs - list clubs with derived member counts and this-week stats
// (#964). Public read; private clubs are only listed to members. memberCount
// comes from club_members; weeklyDistance/activitiesThisWeek are aggregated
// from members' activities in the last 7 days (real data, not stored fiction).
// `?q=` narrows it to clubs whose name or location contains the text.

import type { MembershipRow, WeekActivityRow, WeekTotalRow } from '../../Support/clubWeeklyStats'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { clubMembershipSql, clubWeekStragglersSql, clubWeekTotalsSql, tallyClubWeeks, weekCutoff } from '../../Support/clubWeeklyStats'
import { placeOfText } from '../../Support/placeText'
import { matchesText, textQuery } from '../../Support/textQuery'

export default new Action({
  name: 'Club Index',
  description: 'List clubs with member counts and weekly activity stats',
  method: 'GET',

  async handle(request) {
    try {
      // Session user drives private-club visibility and membership state.
      const sessionUser = (await Auth.user().catch(() => null))?.id ?? null

      const query = textQuery(request.get('q'))
      const clubs = ((await Club.all()) ?? []).filter((c: any) => matchesText(query, c.name, c.location))
      // A search that matches nothing skips the activity totals below.
      if (query && clubs.length === 0)
        return response.json({ success: true, clubs: [], meta: paginate([], readPageParams(request, { defaultLimit: 200, maxLimit: 200 })).meta })

      // Counts and this week's totals come from grouped SQL (see
      // clubWeeklyStats): the list used to load every membership and every
      // activity ever recorded to do this in memory. Only activities the
      // viewer may see are counted (#957), so private member mileage never
      // feeds a public club's weekly numbers.
      const since = weekCutoff()
      const [membershipRows, totalRows, stragglerRows] = await Promise.all([
        db.sql`${db.unsafe(clubMembershipSql(sessionUser))}`.execute(),
        db.sql`${db.unsafe(clubWeekTotalsSql(sessionUser, since))}`.execute(),
        db.sql`${db.unsafe(clubWeekStragglersSql(sessionUser))}`.execute(),
      ]) as [MembershipRow[], WeekTotalRow[], WeekActivityRow[]]

      const membershipByClub = new Map((membershipRows ?? []).map(row => [Number(row.club_id), row]))
      const weekByClub = tallyClubWeeks(totalRows, stragglerRows, since)

      const result = clubs
        .filter((c: any) => !c.is_private || !!membershipByClub.get(c.id)?.is_member)
        .map((c: any) => {
          const membership = membershipByClub.get(c.id)
          const week = weekByClub.get(c.id)
          // Where the club says it is, as the town's centre: what the page
          // needs to put the crews near a visitor first. Derived from the
          // public location text, so it says nothing that text does not.
          const place = placeOfText(c.location)
          return {
            id: c.id,
            name: c.name,
            description: c.description,
            location: c.location,
            lat: place ? Math.round(place.lat * 100) / 100 : null,
            lng: place ? Math.round(place.lng * 100) / 100 : null,
            type: c.club_type,
            isPrivate: !!c.is_private,
            joinPolicy: c.join_policy ?? 'open',
            website: c.website ?? null,
            creatorId: c.creator_id,
            // Note: the raw member-id roster is intentionally NOT exposed on the
            // public listing; memberCount + isMember drive the UI.
            memberCount: Number(membership?.members) || 0,
            isMember: !!membership?.is_member,
            weeklyDistance: Math.round(week?.distance ?? 0),
            activitiesThisWeek: week?.activities ?? 0,
            createdAt: c.created_at,
          }
        })
        .sort((a: any, b: any) => b.memberCount - a.memberCount || a.id - b.id)

      // Generous default - the clubs page has no load-more and expects the
      // full set; ?limit/?offset still paginate on demand (#978 review).
      const paged = paginate(result, readPageParams(request, { defaultLimit: 200, maxLimit: 200 }))
      return response.json({ success: true, clubs: paged.items, meta: paged.meta })
    }
    catch (error) {
      console.error('[clubs] index failed:', error)
      return response.json({ success: false, error: 'Failed to fetch clubs' }, 500)
    }
  },
})

// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. `db` is imported the way
// the other raw-SQL actions import it; the models and response helpers are
// auto-imported as usual.
//
// GET /api/clubs/{id} - club detail for the club page (#964): members (with
// names + roles), a recent activity feed from members, and a weekly-distance
// leaderboard. Public read; a private club only resolves for its members.

import type { WeekActivityRow, WeekTotalRow } from '../../Support/clubWeeklyStats'
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/orm'
import { avatarOf } from '../../Support/avatars'
import { recentClubFeed } from '../../Support/clubRecentFeed'
import { memberWeekStragglersSql, memberWeekTotalsSql, tallyWeeks, weekCutoff } from '../../Support/clubWeeklyStats'

export default new Action({
  name: 'Club Show',
  description: 'Club detail: members, recent activity feed, leaderboard',
  method: 'GET',

  async handle(request) {
    const clubId = positiveInt(request.get('id') ?? request.get('club_id'))
    if (!clubId)
      return response.json({ success: false, error: 'Validation failed', fields: { id: 'required: a positive integer club id' } }, 422)

    try {
      const club = await Club.find(clubId)
      if (!club)
        return response.json({ success: false, error: 'Club not found' }, 404)

      const memberships = (await ClubMember.where('club_id', '=', clubId).get()) ?? []
      const memberIds = memberships.map((m: any) => m.user_id)

      // The private-club gate uses authenticated session identity only.
      const sessionUser = (await Auth.user().catch(() => null))?.id ?? null
      if (club.is_private && (sessionUser === null || !memberIds.includes(sessionUser)))
        return response.json({ success: false, error: 'This club is private' }, 403)

      const users = memberIds.length ? await User.whereIn('id', memberIds).get() : []
      const userName = new Map(users.map((u: any) => [u.id, u.name]))
      const userAvatar = new Map(users.map((u: any) => [u.id, avatarOf(u)]))

      const members = memberships
        .map((m: any) => ({
          userId: m.user_id,
          name: userName.get(m.user_id) ?? 'Unknown',
          avatar: userAvatar.get(m.user_id) ?? null,
          role: m.role,
          joinedAt: m.created_at,
        }))
        .sort((a: any, b: any) => (a.role === 'owner' ? -1 : 0) - (b.role === 'owner' ? -1 : 0))

      // Every member-activity-derived value - the feed AND the weekly
      // leaderboard - must respect each activity's visibility (#957): a
      // member's private/followers-only run can't leak through the club to a
      // viewer who isn't allowed to see it. Both are read in SQL (see
      // clubRecentFeed and clubWeeklyStats) rather than by loading every
      // activity the members have ever recorded.
      const run = async (sql: string) => (await db.sql`${db.unsafe(sql)}`.execute() as any[]) ?? []
      const since = weekCutoff()
      const [feedRows, weekTotals, weekStragglers] = await Promise.all([
        recentClubFeed(run, clubId, sessionUser),
        run(memberWeekTotalsSql(clubId, sessionUser, since)) as Promise<WeekTotalRow[]>,
        run(memberWeekStragglersSql(clubId, sessionUser)) as Promise<WeekActivityRow[]>,
      ])

      const recentFeed = feedRows.map((a: any) => ({
        id: a.id,
        userId: a.user_id,
        userName: userName.get(a.user_id) ?? 'Unknown',
        userAvatar: userAvatar.get(a.user_id) ?? null,
        title: a.trail_id ? `${a.activity_type}` : a.activity_type,
        activityType: a.activity_type,
        distance: a.distance,
        duration: a.duration,
        completedAt: a.completed_at,
      }))

      // Weekly-distance leaderboard among members.
      const weeklyByUser = tallyWeeks(weekTotals, weekStragglers, since)
      const leaderboard = memberIds
        .map((uid: number) => ({
          userId: uid,
          name: userName.get(uid) ?? 'Unknown',
          avatar: userAvatar.get(uid) ?? null,
          weeklyDistance: Math.round((weeklyByUser.get(uid)?.distance ?? 0) * 10) / 10,
          weeklyActivities: weeklyByUser.get(uid)?.activities ?? 0,
        }))
        .sort((a: any, b: any) => b.weeklyDistance - a.weeklyDistance || a.userId - b.userId)
        .map((row: any, i: number) => ({ ...row, rank: i + 1 }))

      const weeklyDistance = leaderboard.reduce((sum: number, r: any) => sum + r.weeklyDistance, 0)
      const activitiesThisWeek = leaderboard.reduce((sum: number, r: any) => sum + r.weeklyActivities, 0)

      return response.json({
        success: true,
        club: {
          id: club.id,
          name: club.name,
          description: club.description,
          location: club.location,
          type: club.club_type,
          isPrivate: !!club.is_private,
          joinPolicy: club.join_policy ?? 'open',
          website: club.website ?? null,
          creatorId: club.creator_id,
          memberCount: members.length,
          members,
          isMember: sessionUser !== null && memberIds.includes(sessionUser),
          weeklyDistance: Math.round(weeklyDistance),
          activitiesThisWeek,
          recentFeed,
          leaderboard,
          createdAt: club.created_at,
        },
      })
    }
    catch (error) {
      console.error('[clubs] show failed:', error)
      return response.json({ success: false, error: 'Failed to fetch club' }, 500)
    }
  },
})

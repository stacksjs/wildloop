// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// GET /api/events - the events directory. Public read.
//
// `?status=live|scheduled|finished`, `?type=backyard|race|group_run|time_trial`,
// `?club=<id>` and `?q=<text>` (name or location) narrow it. Ordering puts
// live events first, then the next ones to start, then the most recently
// finished: what somebody opening this page wants is something to watch right
// now, and failing that, something to enter.
//
// Each row carries `lat`/`lng` (null when unknown) so the page can sort by
// distance from the visitor and filter by radius. That happens in the browser:
// the visitor's position never has to be sent here to get a local list.

import { Auth } from '@stacksjs/auth'
import Event from '../../Models/Event'
import EventEntrant from '../../Models/EventEntrant'
import { matchesText, textQuery } from '../../Support/textQuery'
import { eventPointOf } from '../../Support/eventBoard'

import { currentYard, standings } from '../../../resources/functions/backyard'

const EVENT_TYPES = new Set(['backyard', 'race', 'group_run', 'time_trial'])
const STATUSES = new Set(['scheduled', 'live', 'finished', 'cancelled'])

const STATUS_ORDER: Record<string, number> = { live: 0, scheduled: 1, finished: 2, cancelled: 3 }

export default new Action({
  name: 'Event Index',
  description: 'List events with entrant counts and live progress',
  method: 'GET',

  async handle(request) {
    try {
      const sessionUser = (await Auth.user().catch(() => null))?.id ?? null

      const wantedType = request.get<string>('type')
      const wantedStatus = request.get<string>('status')
      const wantedClub = positiveInt(request.get('club'))
      const query = textQuery(request.get('q'))

      const all = (await Event.all()) ?? []
      const entrants = (await EventEntrant.all()) ?? []

      const entrantsByEvent = new Map<number, any[]>()
      for (const entrant of entrants) {
        const list = entrantsByEvent.get(entrant.event_id) ?? []
        list.push(entrant)
        entrantsByEvent.set(entrant.event_id, list)
      }

      // A club event is only listed to that club's members; a private one only
      // to its host and entrants. Visibility is decided here rather than in
      // the view, so an unlisted event never reaches the browser at all.
      const myClubIds = sessionUser === null
        ? new Set<number>()
        : new Set(((await ClubMember.where('user_id', '=', sessionUser).get()) ?? []).map((m: any) => m.club_id))

      const visible = all.filter((event: any) => {
        if (event.visibility === 'public')
          return true
        if (sessionUser === null)
          return false
        if (event.host_id === sessionUser)
          return true
        if (event.visibility === 'club')
          return event.club_id !== null && myClubIds.has(event.club_id)
        return (entrantsByEvent.get(event.id) ?? []).some((e: any) => e.user_id === sessionUser)
      })

      const clubIds = [...new Set(visible.map((event: any) => event.club_id).filter(Boolean))] as number[]
      const clubs = clubIds.length ? await Club.whereIn('id', clubIds).get() : []
      const clubName = new Map((clubs ?? []).map((club: any) => [club.id, club.name]))

      // Only events that predate their own coordinates need their trail's.
      const trailIds = [...new Set(visible
        .filter((event: any) => event.trail_id && (event.latitude == null || event.longitude == null))
        .map((event: any) => event.trail_id))] as number[]
      const trails = trailIds.length ? await Trail.whereIn('id', trailIds).get().catch(() => []) : []
      const trailById = new Map((trails ?? []).map((trail: any) => [trail.id, trail]))

      const now = Date.now()
      const rows = visible
        .filter((event: any) => {
          if (wantedType && EVENT_TYPES.has(wantedType) && event.event_type !== wantedType)
            return false
          if (wantedStatus && STATUSES.has(wantedStatus) && event.status !== wantedStatus)
            return false
          if (wantedClub && event.club_id !== wantedClub)
            return false
          return matchesText(query, event.name, event.location)
        })
        .map((event: any) => {
          const field = entrantsByEvent.get(event.id) ?? []
          const schedule = {
            startTime: event.start_time,
            yardMinutes: event.yard_minutes,
            loopDistance: event.loop_distance,
            maxYards: event.max_yards,
          }
          const board = standings(
            field.map((entrant: any) => ({
              userId: entrant.user_id,
              status: entrant.status,
              yardsCompleted: entrant.yards_completed ?? 0,
              lastLapAt: entrant.last_lap_at,
            })),
            schedule,
            now,
          )

          const point = eventPointOf(event, event.trail_id ? trailById.get(event.trail_id) : null)

          return {
            id: event.id,
            name: event.name,
            description: event.description,
            location: event.location,
            lat: point?.lat ?? null,
            lng: point?.lng ?? null,
            type: event.event_type,
            status: event.status,
            visibility: event.visibility,
            hostId: event.host_id,
            clubId: event.club_id,
            clubName: event.club_id ? clubName.get(event.club_id) ?? null : null,
            trailId: event.trail_id,
            loopDistance: event.loop_distance,
            yardMinutes: event.yard_minutes,
            startTime: event.start_time,
            maxYards: event.max_yards,
            winnerId: event.winner_id,
            entrantCount: field.length,
            stillIn: board.filter(entry => entry.stillIn).length,
            currentYard: event.status === 'live' ? currentYard(schedule, now) : 0,
            leaderYards: board[0]?.yardsCompleted ?? 0,
            isEntered: sessionUser !== null && field.some((entrant: any) => entrant.user_id === sessionUser),
            createdAt: event.created_at,
          }
        })
        .sort((a: any, b: any) => {
          const order = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
          if (order !== 0)
            return order
          const aStart = Date.parse(a.startTime)
          const bStart = Date.parse(b.startTime)
          // Upcoming: soonest first. Finished: most recent first.
          return a.status === 'finished' ? bStart - aStart : aStart - bStart
        })

      const paged = paginate(rows, readPageParams(request, { defaultLimit: 60, maxLimit: 200 }))
      return response.json({ success: true, events: paged.items, meta: paged.meta })
    }
    catch (error) {
      console.error('[events] index failed:', error)
      return response.json({ success: false, error: 'Failed to fetch events' }, 500)
    }
  },
})

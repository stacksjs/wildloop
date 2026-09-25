// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// GET /api/events/{id} - the event page: everything static about the event,
// plus the current live board so the first paint already has standings rather
// than an empty table that fills in a poll later.

import { Auth } from '@stacksjs/auth'
import Event from '../../Models/Event'
import EventEntrant from '../../Models/EventEntrant'

import { buildLiveBoard, canViewEvent, eventPointOf, syncFieldStatus } from '../../Support/eventBoard'

export default new Action({
  name: 'Event Show',
  description: 'Event detail with the current live board',
  method: 'GET',

  async handle(request) {
    const eventId = positiveInt(request.get('id') ?? request.get('event_id'))
    if (!eventId)
      return response.json({ success: false, error: 'Validation failed', fields: { id: 'required: a positive integer event id' } }, 422)

    try {
      const found = await Event.find(eventId)
      if (!found)
        return response.json({ success: false, error: 'Event not found' }, 404)

      const rawEntrants = (await EventEntrant.where('event_id', '=', eventId).get()) ?? []
      const sessionUser = (await Auth.user().catch(() => null))?.id ?? null

      if (!await canViewEvent(found, sessionUser, rawEntrants.map((entrant: any) => entrant.user_id)))
        return response.json({ success: false, error: 'This event is not public' }, 403)

      const { event, entrants } = await syncFieldStatus(found, rawEntrants)
      const live = await buildLiveBoard(event, entrants)

      const host = await User.find(event.host_id).catch(() => null)
      const club = event.club_id ? await Club.find(event.club_id).catch(() => null) : null
      const trail = event.trail_id ? await Trail.find(event.trail_id).catch(() => null) : null

      const point = eventPointOf(event, trail)

      const mine = sessionUser === null
        ? null
        : entrants.find((entrant: any) => entrant.user_id === sessionUser) ?? null

      return response.json({
        success: true,
        event: {
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
          hostName: host?.name ?? 'Unknown',
          clubId: event.club_id,
          clubName: club?.name ?? null,
          trailId: event.trail_id,
          trailName: trail?.name ?? null,
          loopDistance: event.loop_distance,
          loopRoute: parseLoopRoute(event.loop_route),
          yardMinutes: event.yard_minutes,
          startTime: event.start_time,
          maxYards: event.max_yards,
          winnerId: event.winner_id,
          createdAt: event.created_at,
          isHost: sessionUser !== null && sessionUser === event.host_id,
        },
        me: mine
          ? {
              entered: true,
              status: mine.status,
              bib: mine.bib,
              yardsCompleted: mine.yards_completed ?? 0,
              lastLapAt: mine.last_lap_at,
            }
          : { entered: false },
        live,
      })
    }
    catch (error) {
      console.error('[events] show failed:', error)
      return response.json({ success: false, error: 'Failed to fetch event' }, 500)
    }
  },
})

/**
 * The traced yard loop, as `[[lat,lng],…]`.
 *
 * A malformed blob returns null rather than throwing: an event whose route
 * JSON is corrupt is still an event people are running, and taking the whole
 * page down over the map would be the wrong trade.
 */
function parseLoopRoute(raw: string | null): Array<[number, number]> | null {
  if (!raw)
    return null
  try {
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed))
      return null
    const points = parsed
      .filter((point: unknown): point is [number, number] =>
        Array.isArray(point) && point.length >= 2
        && Number.isFinite(point[0]) && Number.isFinite(point[1]))
      .map((point): [number, number] => [point[0], point[1]])
    return points.length >= 2 ? points : null
  }
  catch {
    return null
  }
}

// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// POST /api/events (auth) - host an event. The host is the session user, never
// the body, and is entered automatically: somebody who sets up a backyard
// ultra is running it unless they say otherwise.
//
// Coordinates: an event on a trail takes the trail's point, because that is
// where the corral is. Otherwise optional `lat`/`lng` (or `latitude`/
// `longitude`) place it. Without either it has no point and sorts last on the
// events page.

import { Auth } from '@stacksjs/auth'
import Event from '../../Models/Event'
import EventEntrant from '../../Models/EventEntrant'

import { STANDARD_YARD_MILES, STANDARD_YARD_MINUTES } from '../../../resources/functions/backyard'
import { toEventPoint } from './event-support'

const EVENT_TYPES = ['backyard', 'race', 'group_run', 'time_trial']
const VISIBILITIES = ['public', 'club', 'private']

export default new Action({
  name: 'Event Store',
  description: 'Create an event; the host is entered automatically',
  method: 'POST',

  async handle(request) {
    const userId = (await Auth.user().catch(() => null))?.id
    if (!userId)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const rawName = request.get<string>('name')
    const name = typeof rawName === 'string' ? rawName.trim() : ''
    const eventType = request.get<string>('event_type') ?? request.get<string>('type') ?? 'backyard'
    const visibility = request.get<string>('visibility') ?? 'public'
    const description = boundedString(request.get('description'), 2000)
    const location = boundedString(request.get('location'), 160)
    const startTime = request.get<string>('start_time') ?? request.get<string>('startTime') ?? ''
    const clubId = positiveInt(request.get('club_id') ?? request.get('clubId'))
    const trailId = positiveInt(request.get('trail_id') ?? request.get('trailId'))

    const loopDistance = Number(request.get('loop_distance') ?? request.get('loopDistance') ?? STANDARD_YARD_MILES)
    const yardMinutes = Number(request.get('yard_minutes') ?? request.get('yardMinutes') ?? STANDARD_YARD_MINUTES)
    const maxYards = positiveInt(request.get('max_yards') ?? request.get('maxYards'))

    const rawLat = request.get('lat') ?? request.get('latitude')
    const rawLng = request.get('lng') ?? request.get('longitude')
    const hasPoint = (rawLat !== undefined && rawLat !== null && rawLat !== '')
      || (rawLng !== undefined && rawLng !== null && rawLng !== '')
    const requestedPoint = hasPoint ? toEventPoint(rawLat, rawLng) : null

    const fields: Record<string, string> = {}
    if (name.length < 3)
      fields.name = 'required: at least 3 characters'
    else if (name.length > 140)
      fields.name = 'must be at most 140 characters'
    if (!EVENT_TYPES.includes(eventType))
      fields.event_type = `must be one of: ${EVENT_TYPES.join(', ')}`
    if (!VISIBILITIES.includes(visibility))
      fields.visibility = `must be one of: ${VISIBILITIES.join(', ')}`

    const startMs = Date.parse(startTime)
    if (!Number.isFinite(startMs))
      fields.start_time = 'required: an ISO 8601 timestamp'

    if (!Number.isFinite(loopDistance) || loopDistance < 0.1 || loopDistance > 100)
      fields.loop_distance = 'must be between 0.1 and 100 miles'
    if (!Number.isInteger(yardMinutes) || yardMinutes < 5 || yardMinutes > 720)
      fields.yard_minutes = 'must be a whole number of minutes between 5 and 720'

    if (hasPoint && !requestedPoint)
      fields.lat = 'lat and lng must both be given, within -90..90 and -180..180'

    // A club event that names no club has no audience it could be visible to,
    // which would silently hide it from everyone including its own entrants.
    if (visibility === 'club' && !clubId)
      fields.club_id = 'required when visibility is "club"'

    if (Object.keys(fields).length)
      return response.json({ success: false, error: 'Validation failed', fields }, 422)

    try {
      // Hosting *for* a club is a claim about that club, so it has to be true.
      if (clubId) {
        const membership = await ClubMember
          .where('club_id', '=', clubId)
          .where('user_id', '=', userId)
          .first()
        if (!membership)
          return response.json({ success: false, error: 'You must be a member of that club to host its events' }, 403)
      }

      // The trail wins over a posted point: the event is where the loop is.
      const trail = trailId ? await Trail.find(trailId).catch(() => null) : null
      const point = toEventPoint(trail?.latitude, trail?.longitude) ?? requestedPoint

      const event = await Event.forceCreate({
        host_id: userId,
        club_id: clubId ?? null,
        trail_id: trailId ?? null,
        name,
        description: description ?? null,
        location: location ?? null,
        latitude: point?.lat ?? null,
        longitude: point?.lng ?? null,
        event_type: eventType,
        // A host can open the gate early, but an event is never born live.
        status: 'scheduled',
        visibility,
        loop_distance: loopDistance,
        loop_route: readLoopRoute(request),
        yard_minutes: yardMinutes,
        start_time: new Date(startMs).toISOString(),
        max_yards: maxYards ?? null,
        winner_id: null,
      })

      await EventEntrant.forceCreate({
        event_id: event.id,
        user_id: userId,
        bib: '1',
        status: 'registered',
        yards_completed: 0,
      }).catch(() => undefined)

      return response.json({
        success: true,
        event: {
          id: event.id,
          name: event.name,
          type: event.event_type,
          status: event.status,
          visibility: event.visibility,
          startTime: event.start_time,
          loopDistance: event.loop_distance,
          yardMinutes: event.yard_minutes,
          maxYards: event.max_yards,
          location: event.location,
          lat: point?.lat ?? null,
          lng: point?.lng ?? null,
          description: event.description,
          clubId: event.club_id,
          hostId: event.host_id,
          entrantCount: 1,
          isEntered: true,
        },
      }, 201)
    }
    catch (error) {
      console.error('[events] store failed:', error)
      return response.json({ success: false, error: 'Failed to create event' }, 500)
    }
  },
})

/** Accept a traced loop, but never store something the map cannot draw. */
function readLoopRoute(request: { get: (key: string) => unknown }): string | null {
  const raw = request.get('loop_route') ?? request.get('loopRoute')
  if (!Array.isArray(raw) || raw.length < 2)
    return null
  const points = raw
    .filter((point: unknown) =>
      Array.isArray(point) && point.length >= 2
      && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1])))
    .map((point: any) => [Number(point[0]), Number(point[1])])
  if (points.length < 2)
    return null
  const encoded = JSON.stringify(points)
  return encoded.length > 2_000_000 ? null : encoded
}

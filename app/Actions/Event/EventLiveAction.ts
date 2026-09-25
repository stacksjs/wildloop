// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// GET /api/events/{id}/live - the poll target for the live page.
//
// Deliberately the same shape as `EventShowAction`'s `live` block and nothing
// else: a spectator refreshing every few seconds should not re-download the
// event description and the host's name each time. Public events answer to
// anybody, with no session, so a race link can be shared with a crew that has
// no Wildloop account.

import { Auth } from '@stacksjs/auth'
import Event from '../../Models/Event'
import EventEntrant from '../../Models/EventEntrant'

import { buildLiveBoard, canViewEvent, syncFieldStatus } from './event-support'

export default new Action({
  name: 'Event Live',
  description: 'Live standings, corral clock, and recent laps for one event',
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
      const live = await buildLiveBoard(event, entrants, { lapLimit: readLapLimit(request) })

      return response.json({ success: true, live })
    }
    catch (error) {
      console.error('[events] live failed:', error)
      return response.json({ success: false, error: 'Failed to fetch live board' }, 500)
    }
  },
})

function readLapLimit(request: { get: (key: string) => unknown }): number {
  const raw = positiveInt(request.get('laps'))
  if (!raw)
    return 40
  return Math.min(raw, 200)
}

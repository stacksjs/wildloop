// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// POST /api/events/{id}/status (auth, host only) - start, finish, or cancel.
//
// Starting is a deliberate act rather than a scheduled one: races are delayed
// by weather and by cars stuck on a fire road, and a corral clock that started
// itself on the original time would put the whole field a yard behind before
// anyone had run a step. Starting late therefore re-bases `start_time` to now,
// which is exactly what a race director does with a start list.

import { Auth } from '@stacksjs/auth'
import Event from '../../Models/Event'
import EventEntrant from '../../Models/EventEntrant'

import { resolveOutcome } from '../../../resources/functions/backyard'
import { scheduleOf } from '../../Support/eventBoard'

const TRANSITIONS: Record<string, string[]> = {
  scheduled: ['live', 'cancelled'],
  live: ['finished', 'cancelled'],
  finished: [],
  cancelled: ['scheduled'],
}

export default new Action({
  name: 'Event Status',
  description: 'Start, finish, or cancel an event (host only)',
  method: 'POST',

  async handle(request) {
    const eventId = positiveInt(request.get('id') ?? request.get('event_id'))
    const userId = (await Auth.user().catch(() => null))?.id

    if (!userId)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!eventId)
      return response.json({ success: false, error: 'Validation failed', fields: { id: 'required: a positive integer event id' } }, 422)

    const wanted = request.get<string>('status')
    if (typeof wanted !== 'string' || !(wanted in TRANSITIONS))
      return response.json({ success: false, error: 'Validation failed', fields: { status: `must be one of: ${Object.keys(TRANSITIONS).join(', ')}` } }, 422)

    try {
      const event = await Event.find(eventId)
      if (!event)
        return response.json({ success: false, error: 'Event not found' }, 404)
      if (event.host_id !== userId)
        return response.json({ success: false, error: 'Only the host can change an event\'s status' }, 403)

      const allowed = TRANSITIONS[event.status] ?? []
      if (!allowed.includes(wanted))
        return response.json({ success: false, error: `Cannot go from ${event.status} to ${wanted}` }, 409)

      const patch: Record<string, unknown> = { status: wanted }

      if (wanted === 'live') {
        // Re-base only a late start. A host opening the gate early should not
        // be able to pull the published start time forward under the field.
        const scheduled = Date.parse(event.start_time)
        const now = Date.now()
        if (Number.isFinite(scheduled) && now > scheduled)
          patch.start_time = new Date(now).toISOString()
      }

      if (wanted === 'finished') {
        const entrants = (await EventEntrant.where('event_id', '=', eventId).get()) ?? []
        const outcome = resolveOutcome(
          entrants.map((entrant: any) => ({
            userId: entrant.user_id,
            status: entrant.status,
            yardsCompleted: entrant.yards_completed ?? 0,
            lastLapAt: entrant.last_lap_at,
          })),
          scheduleOf(event),
        )
        patch.winner_id = outcome.winnerId
        if (outcome.winnerId !== null) {
          const winner = entrants.find((entrant: any) => entrant.user_id === outcome.winnerId)
          if (winner)
            await EventEntrant.update(winner.id, { status: 'winner' }).catch(() => undefined)
        }
      }

      await Event.update(eventId, patch)
      const updated = await Event.find(eventId)

      return response.json({
        success: true,
        event: {
          id: eventId,
          status: updated?.status ?? wanted,
          startTime: updated?.start_time ?? event.start_time,
          winnerId: updated?.winner_id ?? null,
        },
      })
    }
    catch (error) {
      console.error('[events] status change failed:', error)
      return response.json({ success: false, error: 'Failed to update the event' }, 500)
    }
  },
})

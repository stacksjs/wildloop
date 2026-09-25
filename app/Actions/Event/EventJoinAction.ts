// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// POST /api/events/{id}/join (auth) - enter or withdraw from an event.
//
// Idempotent through the (event_id, user_id) unique index, so a double-tap on
// a phone with bad signal resolves to "already entered" rather than two rows.
//
// Withdrawing keeps the entrant row: a backyard result is a record of who
// started, and deleting the row would erase laps already run from the board.

import { Auth } from '@stacksjs/auth'
import Event from '../../Models/Event'
import EventEntrant from '../../Models/EventEntrant'

import { canViewEvent } from '../../Support/eventBoard'

export default new Action({
  name: 'Event Join',
  description: 'Enter or withdraw from an event',
  method: 'POST',

  async handle(request) {
    const eventId = positiveInt(request.get('id') ?? request.get('event_id'))
    const userId = (await Auth.user().catch(() => null))?.id

    if (!userId)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!eventId)
      return response.json({ success: false, error: 'Validation failed', fields: { id: 'required: a positive integer event id' } }, 422)

    try {
      const event = await Event.find(eventId)
      if (!event)
        return response.json({ success: false, error: 'Event not found' }, 404)

      const entrants = (await EventEntrant.where('event_id', '=', eventId).get()) ?? []
      if (!await canViewEvent(event, userId, entrants.map((entrant: any) => entrant.user_id)))
        return response.json({ success: false, error: 'This event is not open to you' }, 403)

      if (event.status === 'finished' || event.status === 'cancelled')
        return response.json({ success: false, error: 'This event is over' }, 400)

      const existing = entrants.find((entrant: any) => entrant.user_id === userId)

      if (existing) {
        if (existing.status === 'withdrawn') {
          // Re-entering before the gun is fine. Once the race is live, a
          // runner who withdrew has already missed corrals they cannot make
          // up, so the honest answer is no.
          if (event.status !== 'scheduled')
            return response.json({ success: false, error: 'The race has started; you cannot re-enter' }, 400)
          await EventEntrant.update(existing.id, { status: 'registered', exit_note: null })
          return response.json({ success: true, entered: true, entrantCount: countActive(entrants, userId, true) })
        }

        const note = boundedString(request.get('note'), 200)
        await EventEntrant.update(existing.id, { status: 'withdrawn', exit_note: note ?? null })
        return response.json({ success: true, entered: false, entrantCount: countActive(entrants, userId, false) })
      }

      // A closed club's event is only open to that club.
      if (event.club_id !== null && event.visibility !== 'public') {
        const membership = await ClubMember
          .where('club_id', '=', event.club_id)
          .where('user_id', '=', userId)
          .first()
        if (!membership)
          return response.json({ success: false, error: 'This event is for club members' }, 403)
      }

      try {
        await EventEntrant.forceCreate({
          event_id: eventId,
          user_id: userId,
          bib: String(entrants.length + 1),
          status: 'registered',
          yards_completed: 0,
        })
      }
      catch (error) {
        // A concurrent double-entry raced the existence check; the unique
        // index kept one row, and the runner is entered either way.
        if (!String(error).includes('UNIQUE constraint failed'))
          throw error
      }

      const after = (await EventEntrant.where('event_id', '=', eventId).get()) ?? []
      return response.json({
        success: true,
        entered: true,
        entrantCount: after.filter((entrant: any) => entrant.status !== 'withdrawn').length,
      })
    }
    catch (error) {
      console.error('[events] join failed:', error)
      return response.json({ success: false, error: 'Failed to update your entry' }, 500)
    }
  },
})

/** Entrant count as it will read after the write we are about to report. */
function countActive(entrants: any[], userId: number, entering: boolean): number {
  const others = entrants.filter((entrant: any) => entrant.user_id !== userId && entrant.status !== 'withdrawn').length
  return others + (entering ? 1 : 0)
}

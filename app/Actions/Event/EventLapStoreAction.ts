// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// POST /api/events/{id}/laps (auth) - report a completed yard.
//
// This is what makes the board live. The recorder calls it the moment a runner
// closes the loop; a host can also post on someone's behalf from the console
// when a phone dies, which is the normal state of affairs by yard 20.
//
// The write is idempotent on (event, user, yard). Lap reports are queued and
// replayed when a phone regains signal at the top of the field, so a duplicate
// has to resolve to "already recorded" rather than inflate a yard count.

import { Auth } from '@stacksjs/auth'
import Event from '../../Models/Event'
import EventEntrant from '../../Models/EventEntrant'
import EventLap from '../../Models/EventLap'

import { currentYard, isStillIn, resolveOutcome, standings } from '../../../resources/functions/backyard'
import { scheduleOf } from '../../Support/eventBoard'

export default new Action({
  name: 'Event Lap Store',
  description: 'Record a completed yard and update the live standings',
  method: 'POST',

  async handle(request) {
    const eventId = positiveInt(request.get('id') ?? request.get('event_id'))
    const sessionUser = (await Auth.user().catch(() => null))?.id

    if (!sessionUser)
      return response.json({ success: false, error: 'Authentication required' }, 401)
    if (!eventId)
      return response.json({ success: false, error: 'Validation failed', fields: { id: 'required: a positive integer event id' } }, 422)

    try {
      const event = await Event.find(eventId)
      if (!event)
        return response.json({ success: false, error: 'Event not found' }, 404)
      if (event.status !== 'live')
        return response.json({ success: false, error: 'This event is not running' }, 400)

      // A host may report for any entrant; everybody else may only report
      // their own laps. Without this, one entrant could retire the field.
      const isHost = event.host_id === sessionUser
      const forUser = positiveInt(request.get('user_id') ?? request.get('userId')) ?? sessionUser
      if (forUser !== sessionUser && !isHost)
        return response.json({ success: false, error: 'Only the host can report another runner\'s lap' }, 403)

      const entrant = await EventEntrant
        .where('event_id', '=', eventId)
        .where('user_id', '=', forUser)
        .first()
      if (!entrant)
        return response.json({ success: false, error: 'That runner is not entered' }, 404)
      if (entrant.status === 'withdrawn')
        return response.json({ success: false, error: 'That runner has withdrawn' }, 400)

      const now = Date.now()
      const schedule = scheduleOf(event)
      const yardNow = currentYard(schedule, now)

      // The yard being reported. Default to the one under way, which is what
      // the recorder means when it posts without a number.
      const yard = positiveInt(request.get('yard') ?? request.get('yard_number')) ?? yardNow
      if (yard < 1)
        return response.json({ success: false, error: 'Validation failed', fields: { yard: 'must be at least 1' } }, 422)

      // A lap can only be reported for the yard in progress, or the one that
      // just closed — a phone that reconnects a minute late still counts. Any
      // further back is a clock problem, not a lap, and accepting it would let
      // a runner backfill yards they never ran.
      if (!isHost && (yard > yardNow || yard < yardNow - 1))
        return response.json({ success: false, error: `Yard ${yard} is not the yard in progress (${yardNow})` }, 409)

      const banked = entrant.yards_completed ?? 0
      if (yard !== banked + 1 && !isHost)
        return response.json({ success: false, error: `Yard ${banked + 1} is your next one` }, 409)

      const finishedAt = readTimestamp(request.get('finished_at') ?? request.get('finishedAt')) ?? new Date(now).toISOString()
      const startedAt = readTimestamp(request.get('started_at') ?? request.get('startedAt'))
      const durationSeconds = readDuration(request, schedule.yardMinutes)
      const distance = readDistance(request)
      const activityId = positiveInt(request.get('activity_id') ?? request.get('activityId'))

      try {
        await EventLap.forceCreate({
          event_id: eventId,
          user_id: forUser,
          yard_number: yard,
          started_at: startedAt,
          finished_at: finishedAt,
          duration_seconds: durationSeconds,
          distance,
          activity_id: activityId ?? null,
          source: isHost && forUser !== sessionUser ? 'manual' : 'recorder',
        })
      }
      catch (error) {
        if (String(error).includes('UNIQUE constraint failed')) {
          // Already recorded. The replayed report is not an error — the caller
          // wanted this lap on the board and it is.
          return response.json({ success: true, duplicate: true, yard, yardsCompleted: banked })
        }
        throw error
      }

      // Recount from the lap rows rather than incrementing. A host filling a
      // gap out of order would otherwise leave the denormalised count wrong
      // for the rest of the race.
      const laps = (await EventLap.where('event_id', '=', eventId).where('user_id', '=', forUser).get()) ?? []
      const yardsCompleted = laps.length

      await EventEntrant.update(entrant.id, {
        status: 'running',
        yards_completed: yardsCompleted,
        last_lap_at: finishedAt,
      })

      // Resolving the race is a read-time job everywhere else, but a winning
      // lap should not wait for a spectator to refresh before it counts.
      const field = (await EventEntrant.where('event_id', '=', eventId).get()) ?? []
      const board = field.map((row: any) => ({
        userId: row.user_id,
        status: row.status,
        yardsCompleted: row.yards_completed ?? 0,
        lastLapAt: row.last_lap_at,
      }))

      for (const row of field) {
        const state = board.find(entry => entry.userId === row.user_id)!
        if ((row.status === 'registered' || row.status === 'running') && !isStillIn(state, schedule, now)) {
          const status = (row.yards_completed ?? 0) > 0 ? 'timed_out' : 'dnf'
          state.status = status
          await EventEntrant.update(row.id, { status }).catch(() => undefined)
        }
      }

      const outcome = resolveOutcome(board, schedule, now)
      if (outcome.finished) {
        await Event.update(eventId, { status: 'finished', winner_id: outcome.winnerId }).catch(() => undefined)
        if (outcome.winnerId !== null) {
          const winner = field.find((row: any) => row.user_id === outcome.winnerId)
          if (winner)
            await EventEntrant.update(winner.id, { status: 'winner' }).catch(() => undefined)
        }
      }

      const ranked = standings(board, schedule, now)
      return response.json({
        success: true,
        duplicate: false,
        yard,
        yardsCompleted,
        stillIn: ranked.filter(entry => entry.stillIn).length,
        rank: ranked.find(entry => entry.userId === forUser)?.rank ?? null,
        finished: outcome.finished,
        winnerId: outcome.finished ? outcome.winnerId : null,
      }, 201)
    }
    catch (error) {
      console.error('[events] lap store failed:', error)
      return response.json({ success: false, error: 'Failed to record the lap' }, 500)
    }
  },
})

function readTimestamp(raw: unknown): string | null {
  if (typeof raw !== 'string')
    return null
  const parsed = Date.parse(raw)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

/** Seconds on the loop, clamped to something a yard could actually contain. */
function readDuration(request: { get: (key: string) => unknown }, yardMinutes: number): number {
  const raw = Number(request.get('duration_seconds') ?? request.get('durationSeconds'))
  const ceiling = Math.max(60, Math.round(yardMinutes * 60))
  if (!Number.isFinite(raw) || raw <= 0)
    return ceiling
  return Math.min(Math.round(raw), 86400)
}

function readDistance(request: { get: (key: string) => unknown }): number | null {
  const raw = Number(request.get('distance'))
  return Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 1000) / 1000 : null
}

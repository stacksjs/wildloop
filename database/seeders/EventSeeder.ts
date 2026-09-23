import { Seeder } from '@stacksjs/database'
import Club from '../../app/Models/Club'
import Event from '../../app/Models/Event'
import EventEntrant from '../../app/Models/EventEntrant'
import User from '../../app/Models/User'

/**
 * Events for a staging catalog: one finished, one live, one scheduled.
 *
 * All three states matter and only one of them is visible at a time in real
 * life, so seeding just an upcoming race leaves the live view and the results
 * view untestable — which is how an empty `/events` page reads as a broken
 * service rather than an empty calendar.
 *
 * The live one is a backyard ultra mid-race, which is the page with the most
 * moving parts: a corral clock, a yard count, and a field that shrinks. Harvey
 * Lewis is deliberately the deepest into it — the format is what he is known
 * for, and a leaderboard is only checkable when the name at the top belongs
 * where it is.
 *
 * Times are relative to when the seeder runs, so a staging database is never
 * showing a "live" event that started last year.
 */

const HOUR = 60 * 60 * 1000

interface SeedEvent {
  name: string
  description: string
  location: string
  /**
   * The point the events page measures distance from. Kept next to
   * `location` so the words and the pin cannot drift apart, and written on
   * every run, so rows seeded before the columns existed pick them up.
   */
  latitude: number
  longitude: number
  event_type: 'backyard' | 'race' | 'group_run' | 'time_trial'
  status: 'scheduled' | 'live' | 'finished'
  /** Hours from now; negative is in the past. */
  startsInHours: number
  loop_distance: number
  /** Backyard only — see the note at the payload. */
  yard_minutes?: number
  /** Entrant name -> yards completed. */
  entrants: Record<string, number>
  winner?: string
}

const EVENTS: SeedEvent[] = [
  {
    name: 'Rappid Backyard Invitational',
    description:
      'A yard every hour until one runner is left. Open corral, crew welcome, '
      + 'and the standings publish live for anyone with the link.',
    location: 'Lehigh Valley, PA',
    // Allentown, the middle of the Lehigh Valley.
    latitude: 40.6084,
    longitude: -75.4902,
    event_type: 'backyard',
    status: 'live',
    startsInHours: -14,
    loop_distance: 4.167,
    yard_minutes: 60,
    entrants: {
      'Harvey Lewis': 14,
      'Pawel Dregan': 13,
      'Mark Dowdle': 11,
      'Chris Breuer': 9,
      'Kim Gottwald': 8,
    },
  },
  {
    name: 'Winter Trail Half',
    description: 'A rolling half on fire road and singletrack. Chip timed, one aid station at the turn.',
    location: 'Boulder, CO',
    latitude: 40.0150,
    longitude: -105.2705,
    event_type: 'race',
    status: 'finished',
    startsInHours: -72,
    loop_distance: 13.1,
    entrants: {
      'Pawel Dregan': 1,
      'Kim Gottwald': 1,
      'Chris Breuer': 1,
    },
    winner: 'Pawel Dregan',
  },
  {
    name: 'Sunday Long Run',
    description: 'Easy group effort, no drop. Meet at the trailhead, back by lunch.',
    location: 'Munich, Bayern',
    latitude: 48.1351,
    longitude: 11.5820,
    event_type: 'group_run',
    status: 'scheduled',
    startsInHours: 60,
    loop_distance: 9.3,
    entrants: {
      'Kim Gottwald': 0,
      'Mark Dowdle': 0,
    },
  },
]

export default class EventSeeder extends Seeder {
  // Events reference a host, a club, and entrants — all seeded before this.
  static override order = -80

  async run(): Promise<void> {
    const users = await User.all().catch(() => [])
    const byName = new Map((users as any[]).map(u => [u.name, u]))
    if (byName.size === 0) {
      console.warn('[seed] no users yet; skipping events')
      return
    }

    const club = await Club.where('name', '=', 'Rappid Run').first().catch(() => null)
    const now = Date.now()

    for (const seed of EVENTS) {
      const host = byName.get(Object.keys(seed.entrants)[0] ?? '') ?? users[0]
      const startTime = new Date(now + seed.startsInHours * HOUR).toISOString()

      // Idempotent by name, so re-seeding refreshes the clock rather than
      // stacking another copy of the same race onto the calendar.
      const existing = await Event.where('name', '=', seed.name).first().catch(() => null)

      const payload = {
        host_id: host.id,
        club_id: seed.event_type === 'backyard' ? club?.id ?? null : null,
        name: seed.name,
        description: seed.description,
        location: seed.location,
        latitude: seed.latitude,
        longitude: seed.longitude,
        event_type: seed.event_type,
        status: seed.status,
        visibility: 'public' as const,
        loop_distance: seed.loop_distance,
        /*
         * `yard_minutes` is the corral interval, which only means anything for
         * a backyard ultra — but the column is NOT NULL and the model
         * validates it, so a race still has to carry a number. Zero is not it:
         * it fails validation, and it would describe a race whose laps start
         * instantly. Non-backyard events take the schema default and ignore
         * the field, which is the honest reading of a column that does not
         * apply to them.
         */
        yard_minutes: seed.yard_minutes ?? 60,
        start_time: startTime,
        winner_id: seed.winner ? byName.get(seed.winner)?.id ?? null : null,
      }

      const event = existing
        ? (await Event.update(existing.id, payload), existing)
        : await Event.forceCreate(payload)

      if (!event?.id)
        continue

      for (const [name, yards] of Object.entries(seed.entrants)) {
        const user = byName.get(name)
        if (!user)
          continue

        const entrant = await EventEntrant
          .where('event_id', '=', event.id)
          .where('user_id', '=', user.id)
          .first()
          .catch(() => null)

        const leaderYards = Math.max(...Object.values(seed.entrants))

        /*
         * The status enum is backyard-shaped — registered, running, timed_out,
         * withdrawn, dnf, winner — because that is the format it was written
         * for. A race has no "finished 4th" to record, so a non-winning
         * finisher is stored as timed_out, which is the closest true thing the
         * column can hold. Worth widening the enum if results pages ever need
         * to tell a finisher apart from someone the clock caught.
         */
        const status = seed.status === 'scheduled'
          ? 'registered'
          : seed.status === 'live'
            ? (yards === leaderYards ? 'running' : 'timed_out')
            : (seed.winner === name ? 'winner' : 'timed_out')

        const entrantPayload = {
          event_id: event.id,
          user_id: user.id,
          yards_completed: yards,
          status,
        }

        // Deliberately unguarded: a swallowed insert here is how this seeder
        // reported success while writing one entrant out of ten.
        if (entrant)
          await EventEntrant.update(entrant.id, entrantPayload)
        else
          await EventEntrant.forceCreate(entrantPayload)
      }
    }
  }
}

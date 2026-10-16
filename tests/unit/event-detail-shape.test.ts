import { describe, expect, it } from 'bun:test'
import {
  canReportLap,
  corralCountdownText,
  currentYardText,
  ENTRANT_STATUS_LABELS,
  entryLabel,
  eventDetailFrom,
  eventIsLive,
  eventJoinPath,
  eventLapPath,
  eventLivePath,
  liveBoardFrom,
  eventPath,
  eventStatusPath,
  lapDurationText,
  lapLine,
  nextLapBody,
  recentLapsFrom,
  standingLine,
  standingStatusText,
  standingYardsText,
  standingsFrom,
  stillInText,
} from '../../resources/functions/events'

/**
 * One event's own board, added when `/event/:id` was promoted.
 *
 * The thing worth pinning is the countdown. The web page runs a local
 * once-a-second tick anchored to the board's `serverTime`, because a corral
 * clock has to be smooth and a device clock three minutes fast would disagree
 * with the one at the start line. A native screen has no promised timer, so it
 * reads `msToNextStart` — which the *server* computed — and says when it read
 * it. Nothing to correct, and nothing that drifts.
 */

const BOARD = {
  serverTime: '2026-10-16T14:00:00.000Z',
  status: 'live',
  currentYard: 7,
  yardStartsAt: '2026-10-16T13:00:00.000Z',
  nextYardStartsAt: '2026-10-16T14:04:12.000Z',
  msToNextStart: 252_000,
  msIntoYard: 3_348_000,
  entrantCount: 40,
  stillIn: 12,
  leaderYards: 7,
  totalMiles: 29.2,
  winnerId: null,
  standings: [
    { rank: 1, userId: 44, name: 'Marta Keller', bib: '14', status: 'running', yardsCompleted: 7, miles: 29.2, stillIn: true, lastLapAt: '2026-10-16T13:52:00.000Z', exitNote: null },
    { rank: 2, userId: 90, name: 'Rui Alves', bib: null, status: 'timed_out', yardsCompleted: 6, miles: 25.0, stillIn: false, lastLapAt: null, exitNote: 'Missed the corral' },
  ],
  recentLaps: [
    { userId: 44, name: 'Marta Keller', yard: 7, finishedAt: '2026-10-16T13:52:00.000Z', durationSeconds: 3_120, distance: 4.167, activityId: null, source: 'manual' },
  ],
}

const PAYLOAD = {
  success: true,
  event: { id: 9, name: 'Cowles Backyard', type: 'backyard', status: 'live', location: 'San Diego, CA', hostId: 44, isHost: false, loopDistance: 4.167, yardMinutes: 60, startTime: '2026-10-16T07:00:00.000Z' },
  live: BOARD,
  me: { entered: true, status: 'running', yardsCompleted: 7, bib: '14' },
}

describe('the event endpoints', () => {
  it('names the board, the entry, the lap and the status', () => {
    expect(eventPath(9)).toBe('/api/events/9')
    expect(eventLivePath(9)).toBe('/api/events/9/live')
    expect(eventJoinPath(9)).toBe('/api/events/9/join')
    // Plural. `/lap` is a 404 that nothing would explain.
    expect(eventLapPath(9)).toBe('/api/events/9/laps')
    expect(eventStatusPath(9)).toBe('/api/events/9/status')
  })
})

describe('eventDetailFrom', () => {
  it('reads the three parts the endpoint answers with', () => {
    const found = eventDetailFrom(PAYLOAD)!

    expect(found.event.name).toBe('Cowles Backyard')
    expect(found.live.currentYard).toBe(7)
    expect(found.me.entered).toBe(true)
  })

  /* A board that has not started yet is absent, not a reason to fail. */
  it('reads an event with no board yet', () => {
    const found = eventDetailFrom({ event: { id: 9, name: 'Later' } })!

    expect(found.live).toBeNull()
    expect(found.me).toEqual({ entered: false })
  })

  it('answers nothing for a payload with no event', () => {
    for (const payload of [null, undefined, {}, { event: null }, { event: {} }, 'nope'])
      expect(eventDetailFrom(payload)).toBeNull()
  })
})

describe('liveBoardFrom', () => {
  it('reads the board out of its envelope', () => {
    expect(liveBoardFrom({ live: BOARD })?.currentYard).toBe(7)
  })

  /*
   * Null rather than the envelope. A dropped poll is normal at a trailhead and
   * the screen keeps the last good board; falling back to the envelope would
   * replace it with something that is not a board.
   */
  it('answers nothing rather than the envelope', () => {
    for (const payload of [null, undefined, {}, { board: BOARD }, 'nope'])
      expect(liveBoardFrom(payload)).toBeNull()
  })
})

describe('corralCountdownText', () => {
  /*
   * Straight off the board. The server computed it, so there is no device
   * clock in the answer and nothing to skew-correct — which is the whole
   * reason a screen that cannot tick can still show it honestly.
   */
  it('reads the server\'s own countdown', () => {
    expect(corralCountdownText(BOARD)).toBe('4:12')
  })

  it('says nothing once the corral has gone', () => {
    expect(corralCountdownText({ ...BOARD, msToNextStart: 0 })).toBe('')
    expect(corralCountdownText({ ...BOARD, msToNextStart: -5000 })).toBe('')
  })

  it('says nothing rather than throwing with no board', () => {
    expect(corralCountdownText(null)).toBe('')
    expect(corralCountdownText({})).toBe('')
    expect(corralCountdownText({ msToNextStart: 'soon' })).toBe('')
  })
})

describe('eventIsLive', () => {
  it('reads the board before the event', () => {
    expect(eventIsLive(BOARD, { status: 'scheduled' })).toBe(true)
    expect(eventIsLive({ status: 'finished' }, { status: 'live' })).toBe(false)
  })

  it('falls back to the event when there is no board', () => {
    expect(eventIsLive(null, { status: 'live' })).toBe(true)
    expect(eventIsLive(null, { status: 'scheduled' })).toBe(false)
  })
})

describe('the standings', () => {
  const rows = standingsFrom(BOARD)

  /*
   * `stillIn` outranks the stored status: somebody who is running reads "In"
   * whatever their row last said. Reading the status alone would show an
   * athlete still out on the course as finished.
   */
  it('reads a runner as in, and a timed-out entrant as out', () => {
    expect(standingStatusText(rows[0])).toBe('In')
    expect(standingStatusText(rows[1])).toBe('Timed out')
  })

  /*
   * The case that actually needs `stillIn` to win. `running` and `registered`
   * both already label as "In", so a row with either proves nothing — only a
   * *stale* status the board has since corrected does. A mis-reported
   * time-out that the board now says is still in must read as still in, which
   * is the whole reason the flag outranks the status.
   */
  it('lets the board overrule a status it has since corrected', () => {
    expect(standingStatusText({ status: 'timed_out', stillIn: true })).toBe('In')
    expect(standingStatusText({ status: 'withdrawn', stillIn: true })).toBe('In')
    expect(standingStatusText({ status: 'dnf', stillIn: true })).toBe('In')
  })

  it('lets a winner outrank being in', () => {
    expect(standingStatusText({ status: 'winner', stillIn: false })).toBe('Winner')
    expect(standingStatusText({ status: 'winner', stillIn: true })).toBe('Winner')
  })

  it('reads an unknown status as out rather than as a slug', () => {
    expect(standingStatusText({ status: 'teleported', stillIn: false })).toBe('Out')
    expect(standingStatusText(null)).toBe('Out')
  })

  it('labels every status the API defines', () => {
    for (const status of ['registered', 'running', 'winner', 'timed_out', 'dnf', 'withdrawn'])
      expect(ENTRANT_STATUS_LABELS[status]).toBeTruthy()
  })

  it('names the entrant, with their bib where there is one', () => {
    expect(standingLine(rows[0])).toBe('1. Marta Keller (14)')
    expect(standingLine(rows[1])).toBe('2. Rui Alves')
  })

  it('counts yards in the singular where it should', () => {
    expect(standingYardsText(rows[0])).toBe('7 yards · 29.2 mi')
    expect(standingYardsText({ yardsCompleted: 1, miles: 4.167 })).toBe('1 yard · 4.2 mi')
    expect(standingYardsText(null)).toBe('0 yards · 0.0 mi')
  })

  it('has nothing to show without a board', () => {
    expect(standingsFrom(null)).toEqual([])
    expect(standingsFrom({ standings: 'nope' })).toEqual([])
  })
})

describe('the laps', () => {
  it('reads a lap as a sentence and a clock', () => {
    const [lap] = recentLapsFrom(BOARD)

    expect(lapLine(lap)).toBe('Marta Keller finished yard 7')
    expect(lapDurationText(lap)).toBe('52:00')
  })

  it('survives a lap with nothing on it', () => {
    expect(lapLine(null)).toBe('Somebody finished yard ?')
    expect(lapDurationText(null)).toBe('0:00')
    expect(recentLapsFrom(null)).toEqual([])
  })
})

describe('the state of the race', () => {
  it('says how many are still out there', () => {
    expect(stillInText(BOARD)).toBe('12 still in of 40')
    expect(stillInText(null)).toBe('0 still in of 0')
  })

  it('names the yard, or says it has not started', () => {
    expect(currentYardText(BOARD)).toBe('Yard 7')
    expect(currentYardText({ currentYard: 0 })).toBe('Not started')
    expect(currentYardText(null)).toBe('Not started')
  })
})

describe('entering and reporting', () => {
  it('says which way the entry button goes', () => {
    expect(entryLabel({ entered: true })).toBe('Withdraw')
    expect(entryLabel({ entered: false })).toBe('Enter')
    expect(entryLabel(null)).toBe('Enter')
  })

  /*
   * A lap report is for an entrant still in a live event. The endpoint
   * refuses the rest, and a button that is refused teaches nothing.
   */
  it('lets an entrant still in report a lap', () => {
    expect(canReportLap(PAYLOAD.me, BOARD, PAYLOAD.event)).toBe(true)
  })

  it('refuses a lap from somebody who is not in it', () => {
    expect(canReportLap({ entered: false }, BOARD, PAYLOAD.event)).toBe(false)
    expect(canReportLap(null, BOARD, PAYLOAD.event)).toBe(false)
  })

  it('refuses a lap from somebody already out', () => {
    for (const status of ['timed_out', 'dnf', 'withdrawn'])
      expect(canReportLap({ entered: true, status }, BOARD, PAYLOAD.event)).toBe(false)
  })

  it('refuses a lap before the event is live', () => {
    expect(canReportLap(PAYLOAD.me, { status: 'scheduled' }, { status: 'scheduled' })).toBe(false)
  })

  it('reports the yard the board says is running', () => {
    expect(nextLapBody(BOARD)).toEqual({ yard: 7 })
    // Never yard zero: a report before the first corral is yard one.
    expect(nextLapBody({ currentYard: 0 })).toEqual({ yard: 1 })
    expect(nextLapBody(null)).toEqual({ yard: 1 })
  })
})

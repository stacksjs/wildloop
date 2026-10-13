import { describe, expect, it } from 'bun:test'
import {
  EVENT_TYPES,
  eventRowsFrom,
  eventSections,
  eventStandingLine,
  eventsPath,
  eventStandingLine as standing,
  eventTypeLabel,
  eventWhenLabel,
} from '../../resources/functions/events'

/**
 * The events directory, as both screens compute it.
 *
 * Extracted from `resources/views/events.stx` when the native screen became the
 * second consumer. The sections matter most: a cancelled event among the plans
 * reads as a plan.
 */

const ROW = {
  id: 3,
  name: 'Sunday Long Run',
  location: 'Munich, Bayern',
  type: 'group_run',
  status: 'scheduled',
  startTime: '2026-09-12T11:23:34.992Z',
  entrantCount: 4,
  stillIn: 0,
  currentYard: 0,
  loopDistance: 9.3,
  yardMinutes: 60,
  clubName: null,
}

describe('eventRowsFrom', () => {
  it('maps the API shape, coercing the numbers', () => {
    const [row] = eventRowsFrom({ events: [{ id: '3', name: 'Sunday Long Run', entrantCount: '4' }] })

    expect(row.id).toBe(3)
    expect(row.entrantCount).toBe(4)
    expect(row.clubName).toBeNull()
  })

  it('never leaves an event without a name', () => {
    expect(eventRowsFrom({ events: [{ id: 1 }] })[0].name).toBe('Untitled event')
  })

  it('returns nothing for a payload that is not a list', () => {
    expect(eventRowsFrom(null)).toEqual([])
    expect(eventRowsFrom({ events: 'soon' })).toEqual([])
  })
})

describe('eventSections', () => {
  const at = (status: string) => ({ status })

  it('splits live, coming up and over', () => {
    const sections = eventSections([at('live'), at('scheduled'), at('finished')])

    expect(sections.live).toHaveLength(1)
    expect(sections.upcoming).toHaveLength(1)
    expect(sections.past).toHaveLength(1)
  })

  /*
   * A cancelled event is not going to happen, and leaving it among the plans
   * reads as a plan.
   */
  it('files a cancelled event with the finished ones', () => {
    const sections = eventSections([at('cancelled')])

    expect(sections.upcoming).toHaveLength(0)
    expect(sections.past).toHaveLength(1)
  })

  it('has somewhere for nothing', () => {
    expect(eventSections([])).toEqual({ live: [], upcoming: [], past: [] })
  })
})

describe('eventTypeLabel', () => {
  it('names every kind it ships with', () => {
    for (const type of EVENT_TYPES)
      expect(eventTypeLabel(type), type).toMatch(/\w/)
    expect(eventTypeLabel('backyard')).toBe('Backyard ultra')
  })

  /** A kind this build does not know still reads as something. */
  it('passes an unknown kind through', () => {
    expect(eventTypeLabel('relay')).toBe('relay')
  })
})

describe('eventWhenLabel', () => {
  it('reads as a day and a time', () => {
    expect(eventWhenLabel(ROW.startTime)).toMatch(/Sep/)
  })

  /*
   * An event whose start nobody recorded still belongs in the list, because
   * somebody is hosting it — so it says so rather than "Invalid Date".
   */
  it('says the date is unconfirmed rather than rendering nonsense', () => {
    expect(eventWhenLabel('')).toBe('Date to be confirmed')
    expect(eventWhenLabel('not a date')).toBe('Date to be confirmed')
  })
})

describe('eventStandingLine', () => {
  /*
   * A backyard ultra mid-race is a standing, not a start time: the yard
   * everybody is on and how many are still in it is the whole sport.
   */
  it('reads a live backyard ultra as its standing', () => {
    expect(standing({ ...ROW, type: 'backyard', status: 'live', currentYard: 14, stillIn: 3 }))
      .toBe('Yard 14 · 3 still in')
  })

  it('says a live race is under way', () => {
    expect(standing({ ...ROW, status: 'live' })).toBe('4 entrants · under way')
  })

  it('counts entrants otherwise, and one as one', () => {
    expect(eventStandingLine(ROW)).toBe('4 entrants')
    expect(eventStandingLine({ ...ROW, entrantCount: 1 })).toBe('1 entrant')
  })
})

describe('eventsPath', () => {
  it('asks for everything, or one kind', () => {
    expect(eventsPath('all')).toBe('/api/events?limit=40')
    expect(eventsPath('backyard')).toBe('/api/events?limit=40&type=backyard')
    expect(eventsPath('all', 5)).toBe('/api/events?limit=5')
  })
})

import type { EventSummary } from '../../resources/assets/scripts/events-api'
import { describe, expect, it } from 'bun:test'
import { eventPointOf, toEventPoint } from '../../app/Support/eventBoard'
import { arrangeEvents, formatMilesAway, milesBetween } from '../../resources/composables/useEvents'

/**
 * The events directory is ordered by distance from the visitor, with live
 * events kept in their own group. These are the rules that ordering and the
 * radius filter promise.
 */

const NEW_YORK = { lat: 40.7128, lng: -74.006 }
const ALLENTOWN = { lat: 40.6084, lng: -75.4902 }
const BOULDER = { lat: 40.015, lng: -105.2705 }
const MUNICH = { lat: 48.1351, lng: 11.582 }
const PHILADELPHIA = { lat: 39.9526, lng: -75.1652 }

let nextId = 1

function event(overrides: Partial<EventSummary>): EventSummary {
  return {
    id: nextId++,
    name: 'Event',
    description: null,
    location: null,
    lat: null,
    lng: null,
    type: 'backyard',
    status: 'scheduled',
    visibility: 'public',
    hostId: 1,
    clubId: null,
    clubName: null,
    trailId: null,
    loopDistance: 4.167,
    yardMinutes: 60,
    startTime: '2026-10-01T12:00:00.000Z',
    maxYards: null,
    winnerId: null,
    entrantCount: 0,
    stillIn: 0,
    currentYard: 0,
    leaderYards: 0,
    isEntered: false,
    ...overrides,
  }
}

describe('milesBetween', () => {
  it('measures real city pairs in miles', () => {
    expect(milesBetween(NEW_YORK, ALLENTOWN)).toBeGreaterThan(75)
    expect(milesBetween(NEW_YORK, ALLENTOWN)).toBeLessThan(82)
    expect(milesBetween(NEW_YORK, MUNICH)).toBeGreaterThan(4000)
    expect(milesBetween(NEW_YORK, MUNICH)).toBeLessThan(4070)
  })

  it('is zero from a place to itself', () => {
    expect(milesBetween(BOULDER, BOULDER)).toBe(0)
  })
})

describe('formatMilesAway', () => {
  it('rounds to whole miles with separators', () => {
    expect(formatMilesAway(12.4)).toBe('12 mi away')
    expect(formatMilesAway(4031.7)).toBe('4,032 mi away')
  })

  it('does not claim zero miles for something close', () => {
    expect(formatMilesAway(0.3)).toBe('Under 1 mi away')
  })

  it('says nothing when the distance is unknown', () => {
    expect(formatMilesAway(null)).toBe('')
  })
})

describe('arrangeEvents', () => {
  const munich = event({ name: 'Sunday Long Run', location: 'Munich, Bayern', ...MUNICH })
  const boulder = event({ name: 'Flatirons Backyard', location: 'Boulder, CO', ...BOULDER })
  const philly = event({ name: 'Wissahickon Loop', location: 'Philadelphia, PA', ...PHILADELPHIA })
  const nowhere = event({ name: 'Secret Backyard', location: null })
  const liveFar = event({ name: 'Live in Boulder', status: 'live', ...BOULDER })
  const liveNear = event({ name: 'Rappid Backyard Invitational', status: 'live', location: 'Lehigh Valley, PA', ...ALLENTOWN })
  const resultNear = event({ name: 'Old Philly Result', status: 'finished', ...PHILADELPHIA })
  const resultFar = event({ name: 'Recent Munich Result', status: 'finished', ...MUNICH })

  // The server's order: live, then upcoming soonest first, then results newest first.
  const serverOrder = [liveFar, liveNear, munich, nowhere, boulder, philly, resultFar, resultNear]

  it('keeps the server order when the visitor is not located', () => {
    const shown = arrangeEvents(serverOrder, { origin: null })
    expect(shown.map(e => e.id)).toEqual(serverOrder.map(e => e.id))
    expect(shown.every(e => e.distanceMiles === null && e.distanceText === '')).toBe(true)
  })

  it('puts the closest first, live events still on top', () => {
    const shown = arrangeEvents(serverOrder, { origin: NEW_YORK })
    expect(shown.map(e => e.name)).toEqual([
      'Rappid Backyard Invitational',
      'Live in Boulder',
      'Wissahickon Loop',
      'Flatirons Backyard',
      'Sunday Long Run',
      // No coordinates: last in its group rather than guessed.
      'Secret Backyard',
      // Results stay newest first.
      'Recent Munich Result',
      'Old Philly Result',
    ])
    expect(shown[0].distanceText).toBe('78 mi away')
  })

  it('cuts to the radius and drops events with no position', () => {
    const shown = arrangeEvents(serverOrder, { origin: NEW_YORK, radius: 100 })
    expect(shown.map(e => e.name)).toEqual([
      'Rappid Backyard Invitational',
      'Wissahickon Loop',
      'Old Philly Result',
    ])
  })

  it('ignores a radius when there is nowhere to measure from', () => {
    expect(arrangeEvents(serverOrder, { origin: null, radius: 25 })).toHaveLength(serverOrder.length)
  })

  it('searches name and location, case-insensitively', () => {
    expect(arrangeEvents(serverOrder, { query: 'bayern' }).map(e => e.name))
      .toEqual(['Sunday Long Run'])
    expect(arrangeEvents(serverOrder, { query: '  BACKYARD ' }).map(e => e.name))
      .toEqual(['Rappid Backyard Invitational', 'Secret Backyard', 'Flatirons Backyard'])
  })

  it('combines search and radius', () => {
    const shown = arrangeEvents(serverOrder, { origin: NEW_YORK, radius: 250, query: 'pa' })
    expect(shown.map(e => e.name)).toEqual(['Rappid Backyard Invitational', 'Wissahickon Loop'])
  })
})

describe('event coordinates', () => {
  it('accepts numbers and numeric strings in range', () => {
    expect(toEventPoint(40.6, -75.4)).toEqual({ lat: 40.6, lng: -75.4 })
    expect(toEventPoint('48.1351', '11.582')).toEqual({ lat: 48.1351, lng: 11.582 })
  })

  it('refuses half a pair, out-of-range values, and (0, 0)', () => {
    expect(toEventPoint(40.6, null)).toBeNull()
    expect(toEventPoint(91, 10)).toBeNull()
    expect(toEventPoint(10, -181)).toBeNull()
    expect(toEventPoint('', '')).toBeNull()
    expect(toEventPoint(0, 0)).toBeNull()
  })

  it('prefers the event point and falls back to its trail', () => {
    const trail = { latitude: 40.015, longitude: -105.2705 }
    expect(eventPointOf({ latitude: 48.1, longitude: 11.5 }, trail)).toEqual({ lat: 48.1, lng: 11.5 })
    expect(eventPointOf({ latitude: null, longitude: null }, trail)).toEqual({ lat: 40.015, lng: -105.2705 })
    expect(eventPointOf({ latitude: null, longitude: null }, null)).toBeNull()
  })
})

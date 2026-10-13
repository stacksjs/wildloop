import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, nodesByTestId, requests, shownText, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'
import { eventStandingLine, eventTypeLabel, eventWhenLabel } from '../../resources/functions/events'

/**
 * The events directory, natively.
 *
 * Fifth list screen, and the first with more than one list on it. What it pins:
 * the three sections are separate lists in the order they matter, a live
 * backyard ultra reads as a standing rather than a start time, and the type
 * filter refilters on the server.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Events.stx'), 'utf8')

const EVENTS = {
  events: [
    { id: 1, name: 'Backyard at the Bluff', location: 'Cincinnati, OH', type: 'backyard', status: 'live', startTime: '2026-10-13T06:00:00.000Z', entrantCount: 12, stillIn: 3, currentYard: 14, loopDistance: 4.167, yardMinutes: 60, clubName: 'Queen City Trail Club' },
    { id: 2, name: 'Sunday Long Run', location: 'Munich, Bayern', type: 'group_run', status: 'scheduled', startTime: '2026-11-02T09:00:00.000Z', entrantCount: 4, stillIn: 0, currentYard: 0, loopDistance: 9.3, yardMinutes: 60, clubName: null },
    { id: 3, name: 'Spring Time Trial', location: 'Boulder, CO', type: 'time_trial', status: 'cancelled', startTime: '2026-04-01T15:00:00.000Z', entrantCount: 9, stillIn: 0, currentYard: 0, loopDistance: 5, yardMinutes: 0, clubName: null },
  ],
}

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function directory() {
  const screen = await start('Events')
  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
  return { screen, request }
}

describe('Wildloop native events screen', () => {
  beforeAll(compileNativeBundle)

  it('renders every list through the portable keyed boundary', () => {
    for (const list of ['live()', 'upcoming()', 'past()'])
      expect(SOURCE).toContain(`:for="row in ${list}" :key="row.id"`)
    expect(SOURCE).not.toContain('<FlatList')
  })

  it('asks the public directory for every kind, and sends no token', async () => {
    const { request } = await directory()

    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/events?limit=40')
    expect(request.payload.args[0].headers.authorization).toBeUndefined()
  })

  /*
   * Three lists rather than one with headings: a live event and a finished one
   * are different things to somebody standing at a start line.
   */
  it('puts each event in its section, with a cancelled one among the finished', async () => {
    const { screen, request } = await directory()
    answer(screen, request, ok(EVENTS))
    await waitForText(screen, 'Backyard at the Bluff')

    const nodes = nodesByTestId(screen.sent.find((m: any) => m.type === 'RENDER')?.payload.document)
    expect(nodes.has('events-scroll')).toBe(true)

    const texts = shownText(screen)
    expect(texts).toContain('Live now')
    expect(texts).toContain('Coming up')
    expect(texts).toContain('Finished')
    // The cancelled time trial is in the finished list, not among the plans.
    expect(texts).toContain('Spring Time Trial')
  })

  it('reads a live backyard ultra as its standing, from the shared module', async () => {
    const { screen, request } = await directory()
    answer(screen, request, ok(EVENTS))
    const texts = await waitForText(screen, 'Backyard at the Bluff')

    expect(texts).toContain(eventStandingLine(EVENTS.events[0] as any))
    expect(texts).toContain('Yard 14 · 3 still in')
    // The club shares the row with the place.
    expect(texts).toContain('Cincinnati, OH · Queen City Trail Club')
  })

  it('shows an upcoming event as its kind and its time', async () => {
    const { screen, request } = await directory()
    answer(screen, request, ok(EVENTS))
    const texts = await waitForText(screen, 'Sunday Long Run')

    const row = EVENTS.events[1] as any
    expect(texts).toContain(`${eventTypeLabel(row.type)} · ${eventWhenLabel(row.startTime)}`)
  })

  it('refilters on the server when the kind changes', async () => {
    const { screen, request } = await directory()
    answer(screen, request, ok(EVENTS))
    await waitForText(screen, 'Sunday Long Run')

    const before = requests(screen).length
    await screen.event('cycle-type', 'onPress')
    const second = await waitForRequest(screen, before, r => r.payload?.module === 'Network')

    expect(second.payload.args[0].url).toContain('type=backyard')
  })

  it('hands a row to the web event board, which is a map screen', async () => {
    const { screen, request } = await directory()
    answer(screen, request, ok(EVENTS))
    await waitForText(screen, 'Backyard at the Bluff')

    await screen.event('live-row', 'onPress')
    await Bun.sleep(0)
    expect(screen.sent.at(-1)).toMatchObject({ type: 'NAVIGATE_OPEN', payload: { path: '/event/1' } })
  })

  it('reports a directory it could not load', async () => {
    const { screen, request } = await directory()
    answer(screen, request, { status: 500, statusText: 'Server Error', headers: {}, body: '{}' })

    await waitForText(screen, 'Could not load events')
  })
})

import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, requests, waitForGeometry, shownText, start, visibility, waitForRequest, waitForText, waitForVisibility } from '../fixtures/nativeScreen'

/**
 * One event's live board, natively.
 *
 * Nineteenth screen. What it pins: the countdown is the server's own
 * `msToNextStart` rather than a device-clock guess and is labelled as a still
 * number, the board re-reads on its own without re-reading the event, a
 * dropped refresh keeps the last good board rather than blanking it, and a lap
 * can only be reported by an entrant still in a live event.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/EventDetail.stx'), 'utf8')

/** The source with comments blanked — prose about a banned token greps the same. */
const CODE = SOURCE
  .replace(/\{\{--[\s\S]*?--\}\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/.*$/gm, '')

const ME = 44

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

function board(over: Record<string, unknown> = {}) {
  return {
    serverTime: '2026-10-16T14:00:00.000Z',
    status: 'live',
    currentYard: 7,
    msToNextStart: 252_000,
    msIntoYard: 3_348_000,
    entrantCount: 40,
    stillIn: 12,
    leaderYards: 7,
    totalMiles: 29.2,
    winnerId: null,
    standings: [
      { rank: 1, userId: ME, name: 'Marta Keller', bib: '14', status: 'running', yardsCompleted: 7, miles: 29.2, stillIn: true, lastLapAt: '2026-10-16T13:52:00.000Z', exitNote: null },
      { rank: 2, userId: 90, name: 'Rui Alves', bib: null, status: 'timed_out', yardsCompleted: 6, miles: 25.0, stillIn: false, lastLapAt: null, exitNote: 'Missed the corral' },
    ],
    recentLaps: [
      { userId: ME, name: 'Marta Keller', yard: 7, finishedAt: '2026-10-16T13:52:00.000Z', durationSeconds: 3_120, distance: 4.167, activityId: null, source: 'manual' },
    ],
    ...over,
  }
}

function detail(over: Record<string, unknown> = {}, live: unknown = board(), me: unknown = { entered: true, status: 'running' }) {
  return {
    success: true,
    event: {
      id: 9,
      name: 'Cowles Backyard',
      description: 'One loop an hour until one of us is left.',
      type: 'backyard',
      status: 'live',
      location: 'San Diego, CA',
      hostId: 90,
      isHost: false,
      loopDistance: 4.167,
      yardMinutes: 60,
      startTime: '2026-10-16T07:00:00.000Z',
      loopRoute: [[32.80, -117.03], [32.81, -117.04], [32.82, -117.03]],
      ...over,
    },
    live,
    me,
  }
}

async function open(id: unknown, body: unknown = detail(), status = 200) {
  const screen = await start('EventDetail', { id })

  if (!/^\d+$/.test(String(id ?? '')) || Number(id) <= 0)
    return { screen }

  const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
  answer(screen, keychain, 'tok_abc')

  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/events/'))
  answer(screen, request, status === 200
    ? ok(body)
    : { status, statusText: 'No', headers: {}, body: '{}' })
  return { screen, request }
}


function textOf(screen: any, testID: string): string {
  const ids = new Map<string, string>()
  const walk = (node: any): void => {
    if (node?.props?.testID)
      ids.set(String(node.props.testID), String(node.props.__stxId))
    for (const child of node?.children ?? []) {
      if (child && typeof child === 'object')
        walk(child)
    }
  }
  walk(screen.sent.find((m: any) => m.type === 'RENDER')?.payload.document)
  const id = ids.get(testID)
  if (!id)
    return ''
  let text = ''
  for (const message of screen.sent.filter((m: any) => m.type === 'MUTATE')) {
    for (const op of message.payload.operations) {
      if (op.id === id && Array.isArray(op.patch?.children))
        text = String(op.patch.children[0] ?? '')
    }
  }
  return text
}

describe('Wildloop native event detail screen', () => {
  beforeAll(compileNativeBundle, 30000)

  it('renders its lists through the portable keyed boundary', () => {
    for (const list of ['standing in standings()', 'lap in laps()'])
      expect(SOURCE).toContain(`:for="${list}"`)
    expect(SOURCE).not.toContain('<FlatList')
  })

  /*
   * The web page runs a poll and a once-a-second tick. The runtime promises
   * no timer, so a screen that ticked would pass here and stop on a phone.
   */
  it('runs no clock of its own', () => {
    expect(CODE).not.toContain('setInterval')
    expect(CODE).not.toContain('setTimeout')
    /*
     * The reason stays in a comment. Whitespace-normalised because a comment
     * wraps, and the first version of this asserted a phrase that was split
     * across two lines.
     */
    expect(SOURCE.replace(/\s+/g, ' ')).toContain('runtime promises no timer')
  })

  it('asks for the event the route named', async () => {
    const { request } = await open('9')

    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/events/9')
  })

  it('loads nothing for a parameter that is not an event', async () => {
    for (const id of ['', 'abc', '0', '-3', '9.5']) {
      const { screen } = await open(id)
      await waitForVisibility(screen, 'event-missing', 'flex')

      expect(requests(screen)).toHaveLength(0)
      expect(visibility(screen, 'event-body')).toBe('none')
    }
  })

  it('reads a 404 as no such event rather than a failure', async () => {
    const { screen } = await open('9', detail(), 404)
    await waitForVisibility(screen, 'event-missing', 'flex')

    expect(visibility(screen, 'event-error')).toBe('none')
  })

  it('shows the event and the state of the race', async () => {
    const { screen } = await open('9')
    const texts = await waitForText(screen, 'Cowles Backyard')

    expect(texts).toContain('Backyard ultra')
    expect(texts).toContain('San Diego, CA')
    expect(texts).toContain('Yard 7')
    expect(texts).toContain('12 still in of 40')
  })

  /*
   * The server computed this, so it is a real number rather than a device
   * clock. 252,000ms is 4:12.
   */
  it('shows the server\'s own countdown', async () => {
    const { screen } = await open('9')
    await waitForText(screen, 'Cowles Backyard')

    expect(textOf(screen, 'corral-clock')).toBe('4:12')
  })

  /*
   * And labels it, because it does not move. A clock that looked live and
   * never ticked would be worse than an honest still one.
   */
  it('says the countdown is a still number, read at a time', async () => {
    const { screen } = await open('9')
    await waitForVisibility(screen, 'event-corral', 'flex')

    expect(textOf(screen, 'corral-note')).toContain('to the next corral, read at')
  })

  it('shows no corral clock once the corral has gone', async () => {
    const { screen } = await open('9', detail({}, board({ msToNextStart: 0 })))
    await waitForText(screen, 'Cowles Backyard')

    expect(visibility(screen, 'event-corral')).toBe('none')
  })

  it('reads a runner as in and a timed-out entrant as out', async () => {
    const { screen } = await open('9')
    const texts = await waitForText(screen, '1. Marta Keller (14)')

    expect(texts).toContain('2. Rui Alves')
    expect(texts).toContain('In')
    expect(texts).toContain('Timed out')
    expect(texts).toContain('7 yards · 29.2 mi')
  })

  it('lists the laps that have landed', async () => {
    const { screen } = await open('9')
    const texts = await waitForText(screen, 'Marta Keller finished yard 7')

    expect(texts).toContain('52:00')
  })

  it('draws the loop, open, because a lap is not a boundary', async () => {
    const { screen } = await open('9')
    await waitForVisibility(screen, 'event-map-frame', 'flex')

    const [drawn] = await waitForGeometry(screen)
    expect(drawn).toEqual([32.80, -117.03, 32.81, -117.04, 32.82, -117.03])
    expect(drawn.slice(0, 2)).not.toEqual(drawn.slice(-2))
  })

  /* The board is what changes during a race; the event is not. */
  it('re-reads the board alone on refresh', async () => {
    const { screen } = await open('9')
    await waitForText(screen, 'Cowles Backyard')

    const before = requests(screen).length
    await screen.event('event-refresh', 'onPress')
    const again = await waitForRequest(screen, before, r => r.payload?.module === 'Network')

    expect(String(again.payload.args[0].url)).toBe('https://wildloop.org/api/events/9/live')
  })

  it('shows the board the refresh brought back', async () => {
    const { screen } = await open('9')
    await waitForText(screen, '12 still in of 40')

    const before = requests(screen).length
    await screen.event('event-refresh', 'onPress')
    const again = await waitForRequest(screen, before, r => r.payload?.module === 'Network')
    answer(screen, again, ok({ live: board({ stillIn: 9, currentYard: 8 }) }))

    await waitForText(screen, '9 still in of 40')
    expect(textOf(screen, 'event-yard')).toBe('Yard 8')
  })

  /*
   * A dropped poll is normal at a trailhead. The last good board stays rather
   * than the screen blanking out.
   */
  it('keeps the last good board when a refresh fails', async () => {
    const { screen } = await open('9')
    await waitForText(screen, '12 still in of 40')

    const before = requests(screen).length
    await screen.event('event-refresh', 'onPress')
    const again = await waitForRequest(screen, before, r => r.payload?.module === 'Network')
    answer(screen, again, { status: 500, statusText: 'No', headers: {}, body: '{}' })
    await Bun.sleep(3)

    expect(textOf(screen, 'event-still-in')).toBe('12 still in of 40')
    expect(visibility(screen, 'event-body')).toBe('flex')
  })

  it('keeps the last good board when a refresh answers without one', async () => {
    const { screen } = await open('9')
    await waitForText(screen, '12 still in of 40')

    const before = requests(screen).length
    await screen.event('event-refresh', 'onPress')
    const again = await waitForRequest(screen, before, r => r.payload?.module === 'Network')
    // An envelope with no `live` is not a board.
    answer(screen, again, ok({ success: true }))
    await Bun.sleep(3)

    expect(textOf(screen, 'event-still-in')).toBe('12 still in of 40')
  })

  it('enters and withdraws through the one endpoint', async () => {
    const { screen } = await open('9', detail({}, board(), { entered: false }))
    await waitForText(screen, 'Cowles Backyard')
    expect(textOf(screen, 'event-entry')).toBe('Enter')

    await screen.event('event-entry', 'onPress')
    const post = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.url ?? '').endsWith('/join'))

    expect(String(post.payload.args[0].method)).toBe('POST')
    answer(screen, post, ok({ success: true, entered: true, entrantCount: 41 }))
    await waitForText(screen, 'Withdraw')
  })

  it('reports a refused entry and keeps the event on screen', async () => {
    const { screen } = await open('9', detail({}, board(), { entered: false }))
    await waitForText(screen, 'Cowles Backyard')

    await screen.event('event-entry', 'onPress')
    const post = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.url ?? '').endsWith('/join'))
    answer(screen, post, ok({ success: false, error: 'Entries have closed.' }))
    await waitForVisibility(screen, 'event-notice', 'flex')

    expect(shownText(screen)).toContain('Entries have closed.')
    expect(visibility(screen, 'event-body')).toBe('flex')
  })

  /*
   * A lap report is for an entrant still in a live event — the endpoint
   * refuses everybody else, and a button that is refused teaches nothing.
   */
  it('offers a lap report to an entrant still in', async () => {
    const { screen } = await open('9')
    await waitForVisibility(screen, 'event-report-lap', 'flex')

    await screen.event('event-report-lap', 'onPress')
    const post = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.url ?? '').endsWith('/laps'))

    expect(String(post.payload.args[0].url)).toBe('https://wildloop.org/api/events/9/laps')
    expect(JSON.parse(String(post.payload.args[0].body))).toEqual({ yard: 7 })
  })

  it('offers no lap report to a spectator, or to somebody already out', async () => {
    const watching = await open('9', detail({}, board(), { entered: false }))
    await waitForText(watching.screen, 'Cowles Backyard')
    expect(visibility(watching.screen, 'event-report-lap')).toBe('none')

    const out = await open('9', detail({}, board(), { entered: true, status: 'timed_out' }))
    await waitForText(out.screen, 'Cowles Backyard')
    expect(visibility(out.screen, 'event-report-lap')).toBe('none')
  })

  it('offers no lap report before the event is live', async () => {
    const { screen } = await open('9', detail({ status: 'scheduled' }, board({ status: 'scheduled', msToNextStart: 0 })))
    await waitForText(screen, 'Cowles Backyard')

    expect(visibility(screen, 'event-report-lap')).toBe('none')
  })

  it('pushes an entrant to their own screen', async () => {
    const { screen } = await open('9')
    await waitForText(screen, '1. Marta Keller (14)')

    await screen.event('event-standing', 'onPress')
    await Bun.sleep(1)
    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE')).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ screen: 'AthleteDetail' }) }),
    )
  })

  it('offers the way back when there is nothing to show', async () => {
    const { screen } = await open('nope')
    await waitForVisibility(screen, 'event-missing', 'flex')

    await screen.event('back-to-events', 'onPress')
    await Bun.sleep(1)
    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE')).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ screen: 'Events' }) }),
    )
  })
})

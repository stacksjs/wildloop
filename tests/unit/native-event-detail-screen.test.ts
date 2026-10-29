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

describe('the field on the loop', () => {
  beforeAll(compileNativeBundle, 30000)

  /**
   * Every pin the host was told to draw, by its id, with the last colour and
   * title it was given. Markers carry an `id` rather than a testID, so this
   * reads the operations instead of going through `nativeNodeProps`.
   */
  function pins(session: any): Array<{ id: string, pinColor?: string, title?: string, geometry?: number[] }> {
    // Keyed by stx's own node id, which is what an operation carries; the
    // authored `id` is a prop, and only the initial RENDER has it. Props are
    // merged across both because the markers' geometry lands a batch later.
    const byNode = new Map<string, any>()
    const merge = (nodeId: string, props: any) => {
      if (props)
        byNode.set(nodeId, { ...(byNode.get(nodeId) ?? {}), ...props })
    }

    const walk = (node: any) => {
      if (!node || typeof node !== 'object')
        return
      if (node.id !== undefined)
        merge(String(node.id), node.props)
      for (const child of node.children ?? [])
        walk(child)
    }

    for (const message of session.sent) {
      if (message.type === 'RENDER')
        walk(message.payload?.tree ?? message.payload)
      else if (message.type === 'MUTATE')
        for (const operation of message.payload.operations)
          merge(String(operation.id), operation.patch?.props ?? operation.props)
    }

    return [...byNode.values()].filter(props => String(props.id ?? '').startsWith('runner-'))
  }

  const START = '2026-10-16T07:00:00.000Z'

  /** Yard 8, twenty minutes in. */
  function field(over: Record<string, unknown> = {}) {
    return board({
      serverTime: '2026-10-16T14:20:00.000Z',
      currentYard: 8,
      standings: [
        // Forty-minute laps, twenty minutes elapsed: half way round.
        { rank: 1, userId: 51, name: 'Ada', avatar: 'https://example.test/ada.jpg', status: 'running', yardsCompleted: 7, stillIn: true, lastLapAt: '2026-10-16T13:45:00.000Z' },
        // Fifteen-minute laps: already past her own lap time.
        { rank: 2, userId: 52, name: 'Grace', status: 'running', yardsCompleted: 7, stillIn: true, lastLapAt: '2026-10-16T13:50:00.000Z' },
        // Both finished yard 8 already and are sitting in the corral.
        { rank: 3, userId: 53, name: 'Edsger', avatar: 'https://example.test/edsger.jpg', status: 'running', yardsCompleted: 8, stillIn: true, lastLapAt: '2026-10-16T14:10:00.000Z' },
        { rank: 4, userId: 54, name: 'Barbara', status: 'running', yardsCompleted: 8, stillIn: true, lastLapAt: '2026-10-16T14:05:00.000Z' },
        // Missed the corral: not on the course at all.
        { rank: 5, userId: 55, name: 'Rui', status: 'timed_out', yardsCompleted: 5, stillIn: false, lastLapAt: null },
      ],
      recentLaps: [
        { userId: 51, name: 'Ada', yard: 7, finishedAt: '2026-10-16T13:45:00.000Z', durationSeconds: 2400, distance: null, activityId: null, source: 'recorder' },
        { userId: 52, name: 'Grace', yard: 7, finishedAt: '2026-10-16T13:50:00.000Z', durationSeconds: 900, distance: null, activityId: null, source: 'recorder' },
        { userId: 53, name: 'Edsger', yard: 8, finishedAt: '2026-10-16T14:10:00.000Z', durationSeconds: 1800, distance: null, activityId: null, source: 'recorder' },
        { userId: 54, name: 'Barbara', yard: 8, finishedAt: '2026-10-16T14:05:00.000Z', durationSeconds: 1800, distance: null, activityId: null, source: 'recorder' },
      ],
      ...over,
    })
  }

  it('pins the runners on the loop and gathers the corral into one', async () => {
    const { screen } = await open('9', detail({ startTime: START }, field()))
    await waitForVisibility(screen, 'event-map-frame', 'flex')
    await waitForGeometry(screen, 2)

    const drawn = pins(screen)
    const ids = drawn.map(pin => pin.id).sort()
    // Two out on the loop, and one pin for the two in the corral rather than
    // two stacked on the start line. The runner who missed the corral is not
    // on the course and gets none.
    expect(ids).toEqual(['runner-51', 'runner-52', 'runner-53'])
    expect(drawn.some(pin => String(pin.title ?? '').includes('Rui'))).toBe(false)
  })

  it('wears each runner\'s own face, and none for the marker that is several people', async () => {
    const { screen } = await open('9', detail({ startTime: START }, field()))
    await waitForVisibility(screen, 'event-map-frame', 'flex')
    await waitForGeometry(screen, 2)

    const byId = new Map(pins(screen).map(pin => [pin.id, pin]))
    // Ada has an https picture, so the pin is her face rather than a dot.
    expect((byId.get('runner-51') as any)?.image).toBe('https://example.test/ada.jpg')
    // Grace has none; the colour is all there is to go on.
    expect((byId.get('runner-52') as any)?.image).toBeNull()
    // And the corral marker stands for two people, so it wears nobody's face
    // — Edsger HAS a picture, and it is deliberately not used here, because
    // one person's photo standing for both is a lie the title then corrects.
    expect((byId.get('runner-53') as any)?.image).toBeNull()
  })

  it('says in colour and in words which positions are measured and which are not', async () => {
    const { screen } = await open('9', detail({ startTime: START }, field()))
    await waitForVisibility(screen, 'event-map-frame', 'flex')
    await waitForGeometry(screen, 2)

    const drawn = pins(screen)
    const byId = new Map(drawn.map(pin => [pin.id, pin]))

    // Grace is past her own lap time: the one runner a spectator needs to spot.
    expect(byId.get('runner-52')?.pinColor).toBe('#dc2626')
    expect(byId.get('runner-52')?.title).toContain('past their own lap time')
    // Ada is running on her own measured pace.
    expect(byId.get('runner-51')?.pinColor).toBe('#059669')
    expect(byId.get('runner-51')?.title).toBe('Ada')
    // The corral names everyone standing in it, since one pin stands for two.
    expect(byId.get('runner-53')?.pinColor).toBe('#94a3b8')
    expect(byId.get('runner-53')?.title).toContain('2 in the corral')
    expect(byId.get('runner-53')?.title).toContain('Barbara')
  })

  it('draws no field at all when the board carries no usable server clock', async () => {
    // The race is deliberately under way by THIS DEVICE's clock, three hours
    // and twenty minutes in, with the entrants' yards to match. So a screen
    // that quietly fell back to the device would draw a full field here, and
    // only the missing server time keeps the map empty. Pinning it against a
    // fixed past date instead proved nothing: the fallback found nobody still
    // in and drew nothing either, so the test passed whatever the code did.
    const deviceStart = new Date(Date.now() - (3 * 60 + 20) * 60_000).toISOString()
    const { screen } = await open('9', detail({ startTime: deviceStart }, field({ serverTime: 'not a time', currentYard: 4 })))
    await waitForVisibility(screen, 'event-map-frame', 'flex')
    await waitForGeometry(screen, 1)

    expect(pins(screen)).toEqual([])
    expect(visibility(screen, 'event-map-note')).toBe('none')
  })
})

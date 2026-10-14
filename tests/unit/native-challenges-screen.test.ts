import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, requests, shownText, shownTextSince, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'

/**
 * Challenges, natively.
 *
 * Eighth screen. What it pins: the viewer's id is read before anything else,
 * because every line on a row depends on which side of it they are on; a
 * finished challenge reads Won or Lost rather than "completed"; only the
 * defender of a pending challenge gets an Accept; and the row is replaced from
 * the challenge the server returns rather than from the button that was
 * pressed.
 */

/**
 * Whether a node is on screen.
 *
 * `:show` keeps the node mounted and hides it with `display: none` — unlike
 * `:if`, which the native runtime ignores entirely (stacksjs/stx#2074). So a
 * control that must not be offered is one that is present and hidden, and
 * only the style says which.
 */
function visibility(screen: any, testID: string): string {
  const ops = screen.sent
    .filter((message: any) => message.type === 'MUTATE')
    .flatMap((message: any) => message.payload.operations)
  const ids = new Set<string>()
  const walk = (node: any): void => {
    if (!node || typeof node !== 'object')
      return
    if (node.props?.testID === testID && node.props?.__stxId)
      ids.add(String(node.props.__stxId))
    ;(node.children ?? []).forEach(walk)
  }
  walk(screen.sent.find((message: any) => message.type === 'RENDER')?.payload.document)
  for (const operation of ops) {
    if (operation.op === 'createNode' && operation.node?.props?.testID === testID)
      ids.add(String(operation.id))
  }
  const display = ops
    .filter((operation: any) => operation.op === 'updateNode' && ids.has(String(operation.id)) && operation.patch?.style?.display)
    .map((operation: any) => operation.patch.style.display)
  return display.at(-1) ?? (ids.size > 0 ? 'shown' : 'absent')
}

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Challenges.stx'), 'utf8')

const ME = 12

const CHALLENGES = {
  success: true,
  challenges: [
    { id: 1, challengerId: ME, challengerName: 'Glenn', challengedId: 30, challengedName: 'Marta Keller', territoryId: 7, territoryName: 'Hirschgarten', status: 'pending', winnerId: null, areaAtStake: 248000, createdAt: '2026-10-12T08:00:00.000Z' },
    { id: 2, challengerId: 30, challengerName: 'Marta Keller', challengedId: ME, challengedName: 'Glenn', territoryId: 9, territoryName: 'Englischer Garten', status: 'pending', winnerId: null, areaAtStake: 1_450_000, createdAt: '2026-10-13T08:00:00.000Z' },
    { id: 3, challengerId: 44, challengerName: 'Tom Byrne', challengedId: ME, challengedName: 'Glenn', territoryId: 5, territoryName: 'Olympiapark', status: 'completed', winnerId: 44, areaAtStake: 62000, createdAt: '2026-09-28T08:00:00.000Z' },
  ],
}

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/**
 * The keychain, then `/api/me`, then the challenges. The order is the point:
 * without the id, "sent", "received", "You" and "Won" all mean nothing.
 */
async function board(token: string | null = 'tok_abc', rows: unknown = CHALLENGES) {
  const screen = await start('Challenges')
  const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
  answer(screen, keychain, token)
  if (token === null)
    return { screen, me: null, request: null }

  const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
  answer(screen, me, ok({ success: true, user: { id: ME, name: 'Glenn' } }))
  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.endsWith('/api/challenges'))
  answer(screen, request, ok(rows))
  return { screen, me, request }
}

describe('Wildloop native challenges screen', () => {
  beforeAll(compileNativeBundle)

  it('renders the list through the portable keyed boundary', () => {
    expect(SOURCE).toContain(':for="row in shown()" :key="row.id"')
    expect(SOURCE).not.toContain('<FlatList')
  })

  it('asks who the viewer is before it asks for their challenges', async () => {
    const { me, request } = await board()

    expect(me.payload.args[0].url).toBe('https://wildloop.org/api/me')
    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/challenges')
    expect(request.payload.args[0].headers.authorization).toBe('Bearer tok_abc')
  })

  it('asks for nothing at all when nobody is signed in', async () => {
    const { screen } = await board(null)
    const texts = await waitForText(screen, 'Sign in on the web to see your challenges.')

    expect(requests(screen).filter((r: any) => r.payload?.module === 'Network')).toHaveLength(0)
    expect(texts).toContain('Sign in on the web to see your challenges.')
  })

  it('puts the viewer on whichever side of the challenge they are on', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, 'You vs Marta Keller')

    expect(texts).toContain('Marta Keller vs You')
  })

  /*
   * The same finished challenge reads Won to one person and Lost to the other,
   * so the row cannot just print its status.
   */
  it('reads a finished challenge as lost, from this viewer\'s side', async () => {
    const { screen } = await board()
    await waitForText(screen, 'You vs Marta Keller')

    await screen.event('cycle-tab', 'onPress')
    await screen.event('cycle-tab', 'onPress')
    await screen.event('cycle-tab', 'onPress')
    const texts = await waitForText(screen, 'Lost')

    expect(texts).toContain('Completed')
    expect(texts).not.toContain('In progress')
  })

  it('names the territory and what it is worth, in the unit the area deserves', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, 'You vs Marta Keller')

    expect(texts).toContain('Hirschgarten · 24.8 ha at stake')
    expect(texts).toContain('Englischer Garten · 1.45 km² at stake')
  })

  it('tells the challenger whose answer it is waiting on', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, 'You vs Marta Keller')

    expect(texts).toContain('Waiting for Marta Keller to respond')
  })

  it('filters in the client, because the board arrives whole', async () => {
    const { screen } = await board()
    await waitForText(screen, 'You vs Marta Keller')

    const before = requests(screen).length
    await screen.event('cycle-tab', 'onPress')
    await Bun.sleep(0)

    expect(requests(screen).length).toBe(before)
    expect(shownText(screen)).toContain('Sent')
  })

  /*
   * Accepting and declining are one endpoint, told apart by the body, and the
   * row is replaced from the challenge that comes back — declining one that
   * was accepted elsewhere should show what actually happened.
   */
  it('answers through the one endpoint, and takes the server\'s challenge back', async () => {
    const { screen } = await board('tok_abc', { success: true, challenges: [CHALLENGES.challenges[1]] })
    await waitForText(screen, 'Marta Keller vs You')

    const before = requests(screen).length
    await screen.event('challenge-accept', 'onPress')
    const respond = await waitForRequest(screen, before, r => r.payload?.module === 'Network')

    expect(respond.payload.args[0].url).toBe('https://wildloop.org/api/challenges/2/respond')
    expect(respond.payload.args[0].method).toBe('POST')
    expect(JSON.parse(respond.payload.args[0].body)).toEqual({ action: 'accept' })

    const afterAnswer = screen.sent.length
    answer(screen, respond, ok({ success: true, challenge: { ...CHALLENGES.challenges[1], status: 'active' } }))
    await waitForText(screen, 'In progress')

    expect(shownTextSince(screen, afterAnswer)).toContain('In progress')
  })

  it('shows what the server did, even when it is not what was pressed', async () => {
    const { screen } = await board('tok_abc', { success: true, challenges: [CHALLENGES.challenges[1]] })
    await waitForText(screen, 'Marta Keller vs You')

    const before = requests(screen).length
    await screen.event('challenge-decline', 'onPress')
    const respond = await waitForRequest(screen, before, r => r.payload?.module === 'Network')
    expect(JSON.parse(respond.payload.args[0].body)).toEqual({ action: 'decline' })

    // Accepted from another device while this one was deciding.
    const afterAnswer = screen.sent.length
    answer(screen, respond, ok({ success: true, challenge: { ...CHALLENGES.challenges[1], status: 'active' } }))
    await waitForText(screen, 'In progress')

    expect(shownTextSince(screen, afterAnswer)).toContain('In progress')
    expect(shownTextSince(screen, afterAnswer)).not.toContain('Declined')
  })

  /*
   * Measured from the moment the rows arrive, not over the whole transcript:
   * the Accept button is in the template either way, so the initial RENDER
   * mentions it whether or not any row actually gets one.
   */
  it('offers no answer on a challenge the viewer sent', async () => {
    const screen = await start('Challenges')
    const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
    answer(screen, keychain, 'tok_abc')
    const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
    answer(screen, me, ok({ success: true, user: { id: ME } }))
    const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.endsWith('/api/challenges'))

    const afterRows = screen.sent.length
    answer(screen, request, ok({ success: true, challenges: [CHALLENGES.challenges[0]] }))
    await waitForText(screen, 'You vs Marta Keller')

    expect(shownTextSince(screen, afterRows)).toContain('You vs Marta Keller')
    expect(visibility(screen, 'challenge-answer')).toBe('none')
  })

  it('does offer one on a challenge the viewer received', async () => {
    const screen = await start('Challenges')
    const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
    answer(screen, keychain, 'tok_abc')
    const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
    answer(screen, me, ok({ success: true, user: { id: ME } }))
    const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.endsWith('/api/challenges'))

    const afterRows = screen.sent.length
    answer(screen, request, ok({ success: true, challenges: [CHALLENGES.challenges[1]] }))
    await waitForText(screen, 'Marta Keller vs You')

    expect(shownTextSince(screen, afterRows)).toContain('Accept')
    expect(visibility(screen, 'challenge-answer')).toBe('flex')
  })

  it('hands the territory to the web page, which is a map', async () => {
    const { screen } = await board()
    await waitForText(screen, 'You vs Marta Keller')

    await screen.event('challenge-territory', 'onPress')
    await Bun.sleep(0)
    expect(screen.sent.at(-1)).toMatchObject({ type: 'NAVIGATE_OPEN', payload: { path: '/territory/9' } })
  })

  it('reports a board it could not load', async () => {
    const screen = await start('Challenges')
    const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
    answer(screen, keychain, 'tok_abc')
    const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
    answer(screen, me, ok({ success: true, user: { id: ME } }))
    const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.endsWith('/api/challenges'))
    answer(screen, request, { status: 500, statusText: 'Server Error', headers: {}, body: '{}' })

    await waitForText(screen, 'Could not load challenges')
  })
})

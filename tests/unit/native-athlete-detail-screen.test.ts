import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, chooseNativeOption, compileNativeBundle, requests, shownText, start, visibility, waitForRequest, waitForText, waitForVisibility } from '../fixtures/nativeScreen'

/**
 * One athlete, natively.
 *
 * Seventeenth screen, and it closes three hand-offs: the directory, the
 * leaderboard and the territory map all opened `/athlete/:id` in a web view.
 *
 * What it pins: the envelope `/api/users/{id}` answers is flattened (a screen
 * reading `payload.name` shows a nameless profile and nothing errors), only
 * *verified* records are listed, a refused follow puts the count back where it
 * started, and a block takes two taps because there is no system dialog and it
 * cuts both follows.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/AthleteDetail.stx'), 'utf8')

const ME = 12
const THEM = 44

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

function envelope(over: Record<string, unknown> = {}) {
  return {
    success: true,
    user: { id: THEM, name: 'Marta Keller', location: 'San Diego, CA', bio: 'Dawn patrol.', avatar: 'marta.jpg' },
    stats: { totalDistance: 412.37, activityCount: 96, totalElevation: 48_210, territoriesOwned: 3 },
    followerCount: 128,
    followingCount: 64,
    isFollowing: false,
    recentActivities: [
      { id: 9, activityType: 'Trail Run', trailName: 'Cowles Mountain', completedAt: '2026-10-15T07:00:00.000Z', distance: 6.23, elevationGain: 1240, route: [[32.70, -117.10], [32.72, -117.12], [32.74, -117.10]] },
      { id: 8, activityType: 'Hike', trailName: null, completedAt: '2026-10-14T07:00:00.000Z', distance: 4, elevationGain: 300 },
    ],
    ...over,
  }
}

const RECORDS = {
  efforts: [
    { id: 31, trailName: 'Steep Ravine Loop', style: 'unsupported', category: 'mens', status: 'verified', elapsedLabel: '1:12:43' },
  ],
}

/** Start on an id, answer the keychain, `/api/me`, the profile and the board. */
async function open(id: unknown, body: unknown = envelope(), status = 200, records: unknown = RECORDS) {
  const screen = await start('AthleteDetail', { id })

  if (!/^\d+$/.test(String(id ?? '')) || Number(id) <= 0)
    return { screen }

  const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
  answer(screen, keychain, 'tok_abc')

  const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
  answer(screen, me, ok({ success: true, user: { id: ME } }))

  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/users/'))
  if (status !== 200) {
    answer(screen, request, { status, statusText: 'No', headers: {}, body: '{}' })
    return { screen, request }
  }
  answer(screen, request, ok(body))

  const board = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/route-efforts'))
  answer(screen, board, records === null ? { status: 500, statusText: 'No', headers: {}, body: '{}' } : ok(records))
  return { screen, request, board }
}

/**
 * The text a node currently shows.
 *
 * `shownText` harvests the whole history, so it cannot answer "what does the
 * follower count say *now*" — every value it has ever held is in there. This
 * walks the operations for the node's own id and takes the last `children`
 * patch, which is the one on screen.
 */
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

/** Every call to the follow endpoint, whichever method it used. */
function followCalls(screen: any) {
  return requests(screen).filter((r: any) =>
    r.payload?.module === 'Network' && String(r.payload.args[0].url ?? '').endsWith('/follow'))
}

describe('Wildloop native athlete detail screen', () => {
  beforeAll(compileNativeBundle, 30000)

  it('renders its lists through the portable keyed boundary', () => {
    for (const list of ['record in records()', 'activity in recent()'])
      expect(SOURCE).toContain(`:for="${list}"`)
    expect(SOURCE).not.toContain('<FlatList')
  })

  it('asks for the athlete the route named', async () => {
    const { request } = await open('44')

    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/users/44')
  })

  /* Verified only: a profile is where a record is read as a credential. */
  it('asks only for verified records', async () => {
    const { board } = await open('44')

    expect(String(board.payload.args[0].url))
      .toBe('https://wildloop.org/api/route-efforts?limit=20&user_id=44&status=verified')
  })

  it('loads nothing for a parameter that is not an athlete', async () => {
    for (const id of ['', 'abc', '0', '-3', '44.5']) {
      const { screen } = await open(id)
      await waitForVisibility(screen, 'athlete-missing', 'flex')

      expect(requests(screen)).toHaveLength(0)
      expect(visibility(screen, 'athlete-body')).toBe('none')
    }
  })

  it('reads a 404 as no such athlete rather than as a failure', async () => {
    const { screen } = await open('44', envelope(), 404)
    await waitForVisibility(screen, 'athlete-missing', 'flex')

    expect(visibility(screen, 'athlete-error')).toBe('none')
  })

  /*
   * The envelope. Reading `payload.name` and `payload.totalDistance` finds
   * neither and shows a nameless profile of zeroes — plausibly, like somebody
   * who has done nothing.
   */
  it('flattens the envelope, rather than showing a nameless profile', async () => {
    const { screen } = await open('44')
    const texts = await waitForText(screen, 'Marta Keller')

    expect(texts).toContain('San Diego, CA')
    expect(texts).toContain('Dawn patrol.')
    expect(texts).toContain('412.4 mi')
    expect(texts).toContain('48,210 ft')
    expect(texts).toContain('96')
    expect(texts).toContain('128')
  })

  it('lists the verified records, and opens one on its own screen', async () => {
    const { screen } = await open('44')
    const texts = await waitForText(screen, 'Steep Ravine Loop')

    expect(texts).toContain('1:12:43')
    await screen.event('athlete-record', 'onPress')
    await Bun.sleep(1)
    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE')).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ screen: 'EffortDetail', params: { id: '31' } }) }),
    )
  })

  it('keeps the profile when the records board cannot be reached', async () => {
    const { screen } = await open('44', envelope(), 200, null)
    await waitForText(screen, 'Marta Keller')

    expect(visibility(screen, 'athlete-body')).toBe('flex')
    expect(visibility(screen, 'athlete-records')).toBe('none')
    expect(visibility(screen, 'athlete-error')).toBe('none')
  })

  it('draws a route thumbnail only where there is a route', async () => {
    const { screen } = await open('44')
    const texts = await waitForText(screen, 'Trail Run · Cowles Mountain')

    expect(texts).toContain('Hike')
    expect(texts).toContain('6.2 mi · 1,240 ft')
    // One of the two recent activities carries a route.
    const drawn = shownText(screen).filter(t => /^[\d.]+,[\d.]+ /.test(t))
    expect(drawn.length).toBeGreaterThan(0)
  })

  it('offers no follow button on your own page', async () => {
    const { screen } = await open('44', envelope({ user: { id: ME, name: 'Glenn' } }))
    await waitForVisibility(screen, 'athlete-self', 'flex')

    expect(visibility(screen, 'athlete-follow')).toBe('none')
    expect(visibility(screen, 'athlete-safety')).toBe('none')
  })

  it('follows with a PUT and counts up', async () => {
    const { screen } = await open('44')
    await waitForText(screen, 'Marta Keller')

    expect(textOf(screen, 'athlete-followers')).toBe('128')

    await screen.event('athlete-follow', 'onPress')
    const put = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'PUT')
    expect(String(put.payload.args[0].url)).toBe('https://wildloop.org/api/users/44/follow')

    answer(screen, put, ok({ success: true, following: true, followerCount: 129 }))
    await waitForText(screen, '129')

    expect(textOf(screen, 'athlete-followers')).toBe('129')
    expect(textOf(screen, 'athlete-follow')).toBe('Following')
  })

  /*
   * The clubs bug, which took 48 members to 47 on a refused join. The count
   * has to return to where it *started*, not move the way the tap did.
   */
  it('puts the count back where it started when a follow is refused', async () => {
    const { screen } = await open('44')
    await waitForText(screen, '128')

    expect(textOf(screen, 'athlete-followers')).toBe('128')

    await screen.event('athlete-follow', 'onPress')
    const put = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'PUT')
    answer(screen, put, ok({ success: false, error: 'They have blocked you.' }))
    await waitForVisibility(screen, 'athlete-notice', 'flex')

    expect(shownText(screen)).toContain('They have blocked you.')
    /*
     * Read off the node rather than searched for in the history: 128 is in
     * `shownText` from the first render whatever happens afterwards, so
     * searching for it would pass even if the count had settled on 127.
     */
    expect(textOf(screen, 'athlete-followers')).toBe('128')
    expect(textOf(screen, 'athlete-follow')).toBe('Follow')
  })

  it('unfollows with a DELETE', async () => {
    const { screen } = await open('44', envelope({ isFollowing: true }))
    await waitForText(screen, 'Marta Keller')

    await screen.event('athlete-follow', 'onPress')
    const gone = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'DELETE')

    expect(String(gone.payload.args[0].url)).toBe('https://wildloop.org/api/users/44/follow')
  })

  it('reports with the reason the viewer picked', async () => {
    const { screen } = await open('44')
    await waitForVisibility(screen, 'athlete-safety', 'flex')

    await chooseNativeOption(screen, 'report-reason', 'Spam')
    await screen.event('athlete-report', 'onPress')
    const posted = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'POST')

    expect(String(posted.payload.args[0].url)).toBe('https://wildloop.org/api/reports')
    const body = JSON.parse(String(posted.payload.args[0].body))
    expect(body).toMatchObject({ subject_type: 'user', subject_id: 44 })
    // The reason chosen from the system sheet.
    expect(body.reason).toBe('spam')
  })

  /*
   * A block cuts both follows and there is no system confirm dialog here, so
   * the first tap arms and says what it will do. One tap must send nothing.
   */
  it('takes two taps to block, and the first sends nothing', async () => {
    const { screen } = await open('44')
    await waitForVisibility(screen, 'athlete-safety', 'flex')

    const before = requests(screen).length
    await screen.event('athlete-block', 'onPress')
    await waitForText(screen, 'Really block? This removes both follows.')
    expect(requests(screen)).toHaveLength(before)

    await screen.event('athlete-block', 'onPress')
    const put = await waitForRequest(screen, before, r => String(r.payload?.args?.[0]?.method ?? '') === 'PUT')
    expect(String(put.payload.args[0].url)).toBe('https://wildloop.org/api/users/44/block')
  })

  it('takes the profile away once they are blocked', async () => {
    const { screen } = await open('44')
    await waitForVisibility(screen, 'athlete-safety', 'flex')

    await screen.event('athlete-block', 'onPress')
    await waitForText(screen, 'Really block? This removes both follows.')
    await screen.event('athlete-block', 'onPress')
    const put = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.method ?? '') === 'PUT')
    answer(screen, put, ok({ success: true, blocked: true }))

    await waitForVisibility(screen, 'athlete-missing', 'flex')
    expect(visibility(screen, 'athlete-body')).toBe('none')
    expect(shownText(screen)).toContain('Blocked. Follow connections are removed.')
  })

  it('offers the way back to the directory when there is nothing to show', async () => {
    const { screen } = await open('nope')
    await waitForVisibility(screen, 'athlete-missing', 'flex')

    await screen.event('back-to-athletes', 'onPress')
    await Bun.sleep(1)
    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE')).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ screen: 'Athletes' }) }),
    )
  })

  /*
   * Counts *any* call to the follow path, not PUTs. Without the in-flight
   * guard the second tap sends a DELETE — the optimistic state has already
   * flipped — so counting one method passes while two requests are in the
   * air, which is exactly what this is meant to catch.
   */
  it('does not send a second request while one is in flight', async () => {
    const { screen } = await open('44')
    await waitForText(screen, 'Marta Keller')

    await screen.event('athlete-follow', 'onPress')
    await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.url ?? '').endsWith('/follow'))
    const during = followCalls(screen).length
    await screen.event('athlete-follow', 'onPress')
    await Bun.sleep(2)

    expect(followCalls(screen)).toHaveLength(during)
    expect(during).toBe(1)
  })
})

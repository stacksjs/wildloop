import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, requests, shownText, shownTextSince, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'
import { avatarUrl } from '../../resources/functions/avatars'
import { leaderMetricText, leaderSecondaryText, metricPhrase, periodPhrase } from '../../resources/functions/leaderboard'

/** A photo path shaped the way the API sends one. */
const AVATAR = '/api/avatars/9/60281ab0-f765-502c-9823-8d57396d33c5.jpg'

/**
 * The leaderboard, natively.
 *
 * Third list screen, first with a remote image on every row. What it pins: the
 * three axes reach the API as one query, the figures come from
 * `resources/functions/leaderboard.ts` rather than being formatted again here,
 * an anonymous row goes nowhere, and `following` asks for a token before it
 * asks for a board.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Leaderboard.stx'), 'utf8')

const BOARD = {
  leaderboard: [
    { rank: 1, userId: null, userName: 'Athlete', userAvatar: null, totalDistance: 509.46, totalElevation: 76953, trailsCompleted: 50 },
    { rank: 2, userId: 9, userName: 'Harvey Lewis', userAvatar: AVATAR, totalDistance: 93.5, totalElevation: 7880, trailsCompleted: 5 },
  ],
}

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function board() {
  const screen = await start('Leaderboard')
  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
  return { screen, request }
}

describe('Wildloop native leaderboard screen', () => {
  beforeAll(compileNativeBundle, 30000)

  it('renders through the portable keyed boundary, with no :if on anything tappable', () => {
    expect(SOURCE).toContain('<Pressable :for="row in rows()" :key="row.rank"')
    expect(SOURCE).not.toContain('<FlatList')
    expect(SOURCE.match(/<(?:Button|Pressable|TouchableOpacity)[^>]*:if=/g)).toBeNull()
  })

  it('asks the public board with the three axes as one query', async () => {
    const { request } = await board()

    expect(request.payload.args[0].url)
      .toBe('https://wildloop.org/api/activities/leaderboard?period=weekly&metric=distance&scope=global')
    expect(request.payload.args[0].headers.authorization).toBeUndefined()
  })

  it('draws a row per athlete, with figures from the shared module', async () => {
    const { screen, request } = await board()
    answer(screen, request, ok(BOARD))

    const texts = await waitForText(screen, 'Harvey Lewis')
    expect(texts).toContain(leaderMetricText(BOARD.leaderboard[1] as any, 'distance'))
    expect(texts).toContain(leaderSecondaryText(BOARD.leaderboard[1] as any, 'distance'))
    expect(texts).toContain(`Who ${metricPhrase('distance')} ${periodPhrase('weekly')}.`)
    // The avatar is a remote image on every row — the first screen to need one —
    // and it asks for the thumbnail, which is what `avatarUrl` answers by
    // default. Composed from the helper so the two cannot drift.
    expect(shownText(screen).some(text => text.includes(avatarUrl(AVATAR)))).toBe(true)
    expect(avatarUrl(AVATAR)).toContain('-thumb.jpg')
    // The anonymous row has no photo, so it shows an initial instead.
    expect(texts).toContain('A')
  })

  /*
   * Changing the measure re-reads the board rather than re-sorting what is in
   * hand: the API ranks it, and a client that re-sorted would disagree with the
   * ranks it was given.
   */
  it('re-reads the board when the measure changes, and says so in the heading', async () => {
    const { screen, request } = await board()
    answer(screen, request, ok(BOARD))
    await waitForText(screen, 'Harvey Lewis')

    const before = requests(screen).length
    const sentBefore = screen.sent.length
    await screen.event('cycle-metric', 'onPress')

    const second = await waitForRequest(screen, before, r => r.payload?.module === 'Network')
    expect(second.payload.args[0].url).toContain('metric=elevation')
    expect(shownTextSince(screen, sentBefore)).toContain(metricPhrase('elevation'))
  })

  /*
   * The anonymous aggregate row has no profile behind it. Tapping it must do
   * nothing rather than open `/athlete/0`.
   */
  it('opens an athlete, and refuses to open the anonymous row', async () => {
    const { screen, request } = await board()
    answer(screen, request, ok(BOARD))
    await waitForText(screen, 'Harvey Lewis')

    /*
     * A push, not a web-view hand-off: `/athlete/:id` is a native screen as of
     * AthleteDetail, and this board was one of three places that opened it by
     * path.
     */
    await screen.event('leader-row', 'onPress')
    await Bun.sleep(1)
    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE')).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ screen: 'AthleteDetail', params: { id: '9' } }) }),
    )

    const anonymous = await start('Leaderboard')
    const only = await waitForRequest(anonymous, 0, r => r.payload?.module === 'Network')
    answer(anonymous, only, ok({ leaderboard: [BOARD.leaderboard[0]] }))
    await waitForText(anonymous, 'Athlete')

    const sentBefore = anonymous.sent.length
    await anonymous.event('leader-row', 'onPress')
    await Bun.sleep(2)
    expect(anonymous.sent.slice(sentBefore).some((message: any) => message.type === 'NAVIGATE_OPEN')).toBe(false)
  })

  /*
   * `following` is the one scope that needs to know who is asking, so it reads
   * the token first and says what signing in would get rather than showing an
   * empty board.
   */
  it('asks for a token before a following board, and explains when there is none', async () => {
    const { screen, request } = await board()
    answer(screen, request, ok(BOARD))
    await waitForText(screen, 'Harvey Lewis')

    await screen.event('cycle-scope', 'onPress')
    const token = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
    expect(token.payload).toMatchObject({ method: 'get', args: ['auth_token'] })

    answer(screen, token, null)
    await waitForText(screen, 'Sign in to see how you rank against the people you follow.')
  })

  it('reports a board it could not load', async () => {
    const { screen, request } = await board()
    answer(screen, request, { status: 500, statusText: 'Server Error', headers: {}, body: '{}' })

    await waitForText(screen, 'Could not load the leaderboard')
  })
})

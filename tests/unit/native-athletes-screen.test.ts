import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, requests, shownText, shownTextSince, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'
import { athleteStatsLine } from '../../resources/functions/athletes'

/**
 * The athlete directory, natively.
 *
 * Fourth list screen and the first that writes per row. What it pins: the two
 * reads that tell the screen who the viewer already follows, the verb each
 * direction of a follow uses, that the button is optimistic and rolls back when
 * the API refuses, and that searching sends what was typed.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Athletes.stx'), 'utf8')

const ATHLETES = {
  success: true,
  athletes: [
    { id: 9, name: 'Harvey Lewis', avatar: null, nearYou: false, activityCount: 6, followerCount: 4, territoriesOwned: 3, totalAreaOwned: 3_030_000 },
    { id: 12, name: 'Kim Gottwald', avatar: null, nearYou: false, activityCount: 5, followerCount: 3, territoriesOwned: 0, totalAreaOwned: 0 },
  ],
}

function ok(body: unknown, status = 200) {
  return { status, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/** The screen as it opens: token, `/api/me`, the follow set, then the list. */
async function directory(options: { followingIds?: number[], signedIn?: boolean } = {}) {
  const signedIn = options.signedIn !== false
  const screen = await start('Athletes')

  const token = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
  answer(screen, token, signedIn ? 'native-token' : null)

  const me = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.url).endsWith('/api/me'))
  answer(screen, me, signedIn ? ok({ user: { id: 5 } }) : ok({ success: false }, 401))

  if (signedIn) {
    const follows = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.url).includes('/follows'))
    answer(screen, follows, ok({ followingIds: options.followingIds ?? [] }))
  }

  const search = await waitForRequest(screen, 0, r => String(r.payload?.args?.[0]?.url).includes('/api/users/search'))
  answer(screen, search, ok(ATHLETES))
  await waitForText(screen, 'Harvey Lewis')
  return screen
}

describe('Wildloop native athletes screen', () => {
  beforeAll(compileNativeBundle)

  it('renders through the portable keyed boundary', () => {
    expect(SOURCE).toContain('<View :for="row in rows()" :key="row.id"')
    expect(SOURCE).not.toContain('<FlatList')
  })

  it('reads who the viewer follows before offering to follow anybody', async () => {
    const screen = await directory({ followingIds: [12] })

    const urls = requests(screen).map(request => String(request.payload?.args?.[0]?.url ?? ''))
    expect(urls.some(url => url.endsWith('/api/me'))).toBe(true)
    expect(urls.some(url => url.includes('/api/users/5/follows'))).toBe(true)

    // Kim is followed already, Harvey is not — so the buttons differ.
    const texts = shownText(screen)
    expect(texts).toContain('Following')
    expect(texts).toContain('Follow')
  })

  it('shows each athlete’s record in the words the web page uses', async () => {
    const screen = await directory()

    const texts = shownText(screen)
    expect(texts).toContain(athleteStatsLine(ATHLETES.athletes[0] as any))
    // The second holds no ground, so the row says nothing about territory.
    expect(texts).toContain('5 activities · 3 followers')
  })

  /*
   * `PUT` to follow. The button changes before the request lands, because a
   * follow that waits for a round trip reads as a tap that did nothing.
   */
  it('follows with PUT, optimistically', async () => {
    const screen = await directory()

    const before = requests(screen).length
    const sentBefore = screen.sent.length
    await screen.event('follow-toggle', 'onPress')

    expect(shownTextSince(screen, sentBefore)).toContain('Following')
    const write = await waitForRequest(screen, before, r => String(r.payload?.args?.[0]?.url).includes('/follow'))
    expect(write.payload.args[0].method).toBe('PUT')
    expect(write.payload.args[0].headers.authorization).toBe('Bearer native-token')
  })

  /*
   * And back again when the API refuses: the button must not keep claiming
   * something that did not happen.
   */
  it('rolls the button back when the write fails', async () => {
    const screen = await directory()

    const before = requests(screen).length
    await screen.event('follow-toggle', 'onPress')
    const write = await waitForRequest(screen, before, r => String(r.payload?.args?.[0]?.url).includes('/follow'))

    const sentBefore = screen.sent.length
    answer(screen, write, ok({ success: false }, 500))
    await Bun.sleep(4)

    expect(shownTextSince(screen, sentBefore)).toContain('Follow')
  })

  it('searches for what was typed', async () => {
    const screen = await directory()

    await screen.event('athlete-search', 'onChangeText', { text: 'harv' })
    const before = requests(screen).length
    await screen.event('run-search', 'onPress')

    const search = await waitForRequest(screen, before, r => String(r.payload?.args?.[0]?.url).includes('/api/users/search'))
    expect(search.payload.args[0].url).toContain('q=harv')
  })

  /*
   * A signed-out visitor still gets the directory — it is public — and is told
   * what signing in would add rather than being shown follow buttons that
   * cannot work.
   */
  it('shows the directory to a signed-out visitor, and says what signing in adds', async () => {
    const screen = await directory({ signedIn: false })

    expect(shownText(screen)).toContain('Harvey Lewis')
    await waitForText(screen, 'Sign in to follow athletes and see their runs in your feed.')
  })
})

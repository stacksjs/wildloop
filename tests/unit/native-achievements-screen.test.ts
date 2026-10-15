import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, requests, shownText, shownTextSince, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'

/**
 * Achievements, natively.
 *
 * Ninth screen, and the first that draws a chart. What it pins: the year is
 * twelve bound rects rather than twelve percentage heights, the badges and the
 * activities are fetched together rather than one after the other, an over-run
 * badge still reads as full, and nothing is asked for at all when nobody is
 * signed in.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Achievements.stx'), 'utf8')

const ME = 12

const BADGES = {
  success: true,
  achievements: [
    { id: 1, name: 'First Loop', description: 'Close your first loop.', icon: '🔁', progress: 1, total: 1 },
    { id: 2, name: 'Empire Builder', description: 'Hold 10 territories.', icon: '🏰', progress: 14, total: 10 },
    { id: 3, name: 'Century', description: 'Run 100 miles.', icon: '💯', progress: 82, total: 100 },
  ],
}

/*
 * The shape `/api/activities` actually answers in — `completedAt`, a
 * `movingTime` string, `elevationGain`. The first version of this fixture
 * invented `startTime` and a numeric duration, and every number came out
 * empty, which is the fixture being wrong rather than the screen.
 */
const ACTIVITIES = {
  success: true,
  activities: [
    { id: 90, userId: ME, title: 'Isar loop', distance: 12.4, movingTime: '1:30:00', elevationGain: 820, completedAt: '2026-03-08T07:00:00.000Z' },
    { id: 91, userId: ME, title: 'Hirschgarten repeats', distance: 6.2, movingTime: '0:40:00', elevationGain: 240, completedAt: '2026-05-02T07:00:00.000Z' },
    { id: 92, userId: 44, title: 'Somebody else\'s run', distance: 99, movingTime: '9:00:00', elevationGain: 9999, completedAt: '2026-05-03T07:00:00.000Z' },
  ],
}

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/** Keychain, then `/api/me`, then the badges and the activities together. */
async function board(token: string | null = 'tok_abc') {
  const screen = await start('Achievements')
  const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
  answer(screen, keychain, token)
  if (token === null)
    return { screen }

  const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
  answer(screen, me, ok({ success: true, user: { id: ME } }))

  const badgeRequest = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/achievements'))
  const activityRequest = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/activities'))
  answer(screen, badgeRequest, ok(BADGES))
  answer(screen, activityRequest, ok(ACTIVITIES))
  return { screen, badgeRequest, activityRequest }
}

describe('Wildloop native achievements screen', () => {
  beforeAll(compileNativeBundle)

  it('renders each list through the portable keyed boundary', () => {
    for (const list of ['bar in bars()', 'record in records()', 'badge in badges()'])
      expect(SOURCE).toContain(`:for="${list}"`)
    expect(SOURCE).not.toContain('<FlatList')
  })

  /*
   * The bar's geometry is bound. `:height` and `:y` on a rect register as
   * bindings, which is what makes a chart possible at all.
   */
  it('binds every bar\'s geometry', () => {
    for (const binding of [':x="bar.x"', ':y="bar.y"', ':width="bar.width"', ':height="bar.height"'])
      expect(SOURCE).toContain(binding)
  })

  it('asks for the badges and the activities together, not one after the other', async () => {
    const { badgeRequest, activityRequest } = await board()

    expect(badgeRequest.payload.args[0].url).toBe('https://wildloop.org/api/users/12/achievements')
    expect(activityRequest.payload.args[0].url).toBe('https://wildloop.org/api/activities?user_id=12&limit=500')
    expect(badgeRequest.payload.args[0].headers.authorization).toBe('Bearer tok_abc')
  })

  it('asks for nothing at all when nobody is signed in', async () => {
    const { screen } = await board(null)
    await waitForText(screen, 'Sign in on the web to see your achievements.')

    expect(requests(screen).filter((r: any) => r.payload?.module === 'Network')).toHaveLength(0)
  })

  it('reads the year from the athlete\'s own rows', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, '18.6 mi this year')

    // The 99-mile row belongs to somebody else and is not in the total.
    expect(texts).not.toContain('117.6 mi this year')
    expect(texts).toContain('March was the biggest, at 12.4 mi')
  })

  it('shows the personal bests the shared module computes', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, 'Isar loop')

    expect(texts).toContain('12.4 mi')
    expect(texts).toContain('Longest activity')
  })

  it('reads an over-run badge as full, because achievements never un-earn', async () => {
    const { screen } = await board()
    // The row renders the icon and the name as one line, and shownText
    // matches whole strings rather than substrings.
    const texts = await waitForText(screen, '🏰 Empire Builder')

    expect(texts).toContain('10/10')
    expect(texts).not.toContain('14/10')
  })

  it('puts the earned badges first', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, '🔁 First Loop')

    const order = texts.filter(text => ['🔁 First Loop', '🏰 Empire Builder', '💯 Century'].includes(text))
    expect(order).toEqual(['🔁 First Loop', '🏰 Empire Builder', '💯 Century'])
  })

  it('opens the activity that set a record', async () => {
    const { screen } = await board()
    await waitForText(screen, 'Isar loop')

    await screen.event('record-row', 'onPress')
    await Bun.sleep(0)
    expect(screen.sent.at(-1)).toMatchObject({ type: 'NAVIGATE_OPEN', payload: { path: '/activity/90' } })
  })

  it('reports activities it could not load', async () => {
    const screen = await start('Achievements')
    const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
    answer(screen, keychain, 'tok_abc')
    const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
    answer(screen, me, ok({ success: true, user: { id: ME } }))
    const badgeRequest = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/achievements'))
    const activityRequest = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/activities'))

    const since = screen.sent.length
    answer(screen, badgeRequest, ok(BADGES))
    answer(screen, activityRequest, { status: 500, statusText: 'Server Error', headers: {}, body: '{}' })
    await waitForText(screen, 'Could not load your activities')

    // The badges that did arrive are still shown.
    expect(shownTextSince(screen, since)).toContain('🔁 First Loop')
    expect(shownText(screen)).toContain('Could not load your activities')
  })
})

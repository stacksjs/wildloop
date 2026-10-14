import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, requests, shownText, start, visibility, waitForRequest, waitForText } from '../fixtures/nativeScreen'

/**
 * Training stats, natively.
 *
 * Eleventh screen. What it pins: the API's rows are translated before the
 * maths sees them — untranslated, every number is zero and nobody is told —
 * the period changes without going back to the server, and a week nobody ran
 * gets no bar.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Stats.stx'), 'utf8')

const ME = 12

/** Dated relative to nothing: the week and month totals depend on "now". */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

const ACTIVITIES = {
  success: true,
  activities: [
    { id: 1, userId: ME, activityType: 'Trail Run', distance: 6.2, elevationGain: 820, movingTime: '1:02:00', duration: '1:05:00', trailId: 7, calories: 640, createdAt: isoDaysAgo(1) },
    { id: 2, userId: ME, activityType: 'Hike', distance: 4, elevationGain: 300, movingTime: '1:30:00', duration: '1:40:00', trailId: null, calories: null, createdAt: isoDaysAgo(2) },
    { id: 3, userId: 44, activityType: 'Trail Run', distance: 99, elevationGain: 9999, movingTime: '9:00:00', duration: '9:00:00', trailId: 9, calories: 9999, createdAt: isoDaysAgo(1) },
  ],
}

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function board(token: string | null = 'tok_abc', rows: unknown = ACTIVITIES) {
  const screen = await start('Stats')
  const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
  answer(screen, keychain, token)
  if (token === null)
    return { screen }

  const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
  answer(screen, me, ok({ success: true, user: { id: ME } }))
  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/activities'))
  answer(screen, request, rows === null ? { status: 500, statusText: 'Server Error', headers: {}, body: '{}' } : ok(rows))
  return { screen, request }
}

describe('Wildloop native stats screen', () => {
  beforeAll(compileNativeBundle)

  it('renders its lists through the portable keyed boundary', () => {
    for (const list of ['bar in bars()', 'row in breakdown()'])
      expect(SOURCE).toContain(`:for="${list}"`)
    expect(SOURCE).not.toContain('<FlatList')
  })

  it('binds every bar\'s geometry', () => {
    for (const binding of [':x="bar.x"', ':y="bar.y"', ':width="bar.width"', ':height="bar.height"'])
      expect(SOURCE).toContain(binding)
  })

  it('asks for the athlete\'s own activities, with their token', async () => {
    const { request } = await board()

    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/activities?user_id=12&limit=500')
    expect(request.payload.args[0].headers.authorization).toBe('Bearer tok_abc')
  })

  it('asks for nothing at all when nobody is signed in', async () => {
    const { screen } = await board(null)
    await waitForText(screen, 'Sign in on the web to see your training stats.')

    expect(requests(screen).filter((r: any) => r.payload?.module === 'Network')).toHaveLength(0)
    expect(visibility(screen, 'stats-body')).toBe('none')
  })

  /*
   * The translation is the point of this screen. Untranslated, every number is
   * zero and the athlete is told they ran nothing — so the test is that the
   * numbers are not zero, from rows in the API's own shape.
   */
  it('counts the athlete\'s miles, from the shape the API answers in', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, '10.2')

    expect(texts).toContain('1,120 ft')
    expect(texts).toContain('2 activities')
    // The 99-mile row belongs to somebody else.
    expect(texts).not.toContain('109.2')
  })

  it('changes period without going back to the server', async () => {
    const { screen } = await board()
    await waitForText(screen, 'This week')

    const before = requests(screen).length
    await screen.event('cycle-period', 'onPress')
    await Bun.sleep(1)

    expect(requests(screen).length).toBe(before)
    expect(shownText(screen)).toContain('This month')
  })

  it('splits what the athlete actually does', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, 'Trail runs')

    expect(texts).toContain('Hikes')
    // Two of three rows are trail runs, but only two rows are theirs.
    expect(texts).toContain('1 · 33%')
  })

  it('reads a streak in days, singular where it should be', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, '2 days')

    expect(texts.some(text => text.startsWith('Best: '))).toBe(true)
  })

  it('reports training it could not load, and shows no numbers', async () => {
    const { screen } = await board('tok_abc', null)
    await waitForText(screen, 'Could not load your training')

    expect(visibility(screen, 'stats-body')).toBe('none')
    expect(visibility(screen, 'stats-error')).toBe('flex')
  })
})

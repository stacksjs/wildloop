import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, requests, shownText, start, visibility, waitForRequest, waitForText } from '../fixtures/nativeScreen'

/**
 * The live battle feed, natively.
 *
 * Thirteenth screen, and the only one that works signed out — the endpoint
 * answers without a viewer, so a signed-out athlete sees the game being
 * played. What it pins: that it loads with no token, that the period changes
 * without going back to the server, and that it speaks in the feed's third
 * person rather than the conquests screen's second.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Battles.stx'), 'utf8')

const ME = 12
const RIVAL = 44

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/*
 * The period filter reads the real clock, so a fixture dated "two hours ago"
 * is yesterday's battle when the suite runs at 01:00. These anchor to local
 * midnight instead, which is inside "today" whatever time it is.
 */
function todayAt(minutesAfterMidnight: number): string {
  const midnight = new Date().setHours(0, 0, 0, 0)
  return new Date(midnight + minutesAfterMidnight * 60_000).toISOString()
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

const FEED = {
  success: true,
  battles: [
    { id: 1, territory_id: 7, territoryName: 'Balboa Loop', centerLat: 32.73, centerLng: -117.15, attacker_id: RIVAL, attackerName: 'Marta', defender_id: ME, defenderName: 'Glenn', status: 'active', areaCaptured: 1200, runDistance: 5.1, created_at: todayAt(1) },
    { id: 2, territory_id: 8, territoryName: 'Switchback Ridge', centerLat: 32.80, centerLng: -117.20, attacker_id: 90, attackerName: 'Rui', defender_id: 91, defenderName: 'Ada', status: 'conquered', areaCaptured: 90_000, runDistance: 8.2, created_at: todayAt(2) },
    { id: 3, territory_id: 9, territoryName: 'Old Mill', centerLat: 32.60, centerLng: -117.05, attacker_id: 92, attackerName: 'Tam', defender_id: 93, defenderName: 'Joe', status: 'defended', areaCaptured: 0, runDistance: 3.3, created_at: daysAgo(10) },
  ],
}

async function board(token: string | null = null, payload: unknown = FEED) {
  const screen = await start('Battles')
  const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
  answer(screen, keychain, token)
  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
  answer(screen, request, payload === null ? { status: 500, statusText: 'Server Error', headers: {}, body: '{}' } : ok(payload))
  return { screen, request }
}

describe('Wildloop native battles screen', () => {
  beforeAll(compileNativeBundle, 30000)

  it('renders its list through the portable keyed boundary', () => {
    expect(SOURCE).toContain(':for="battle in shown()"')
    expect(SOURCE).not.toContain('<FlatList')
  })

  /*
   * The feed is public. Every other native screen gates on a token; this one
   * must not, or a signed-out athlete is told to sign in to watch a game that
   * would have answered them.
   */
  it('loads the feed with no token at all', async () => {
    const { screen, request } = await board(null)

    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/territories/battles?limit=200')
    expect(request.payload.args[0].headers.authorization).toBeUndefined()
    await waitForText(screen, 'Marta is attacking Balboa Loop')
  })

  it('sends the token when there is one, so blocks are applied', async () => {
    const { request } = await board('tok_abc')

    expect(request.payload.args[0].headers.authorization).toBe('Bearer tok_abc')
  })

  /*
   * The feed's voice: third person, about other people. The conquests screen
   * tells the same row in the second person, and the two web pages used to
   * disagree about which was which.
   */
  it('speaks about other people, not to the viewer', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, 'Marta is attacking Balboa Loop')

    expect(texts).toContain('Rui conquered Switchback Ridge')
    // No second-person voice anywhere on this screen.
    expect(texts.some(text => text.startsWith('You '))).toBe(false)
  })

  it('badges a battle still open as contested', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, 'Contested')

    expect(texts).toContain('Conquered')
  })

  it('counts what is live and what settled', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, '1 live battle')

    expect(shownText(screen)).toContain('Live')
    // 90,000 m² is nine hectares: `formatTerritoryArea` picks the unit.
    expect(texts).toContain('9.00 ha')
  })

  it('changes period without going back to the server', async () => {
    const { screen } = await board()
    await waitForText(screen, 'Today')

    const before = requests(screen).length
    await screen.event('cycle-period', 'onPress')
    await Bun.sleep(1)

    expect(requests(screen).length).toBe(before)
    expect(shownText(screen)).toContain('This week')
  })

  /*
   * The three-day-old battle is outside today and inside all time, so the
   * period filter is doing something rather than being decorative.
   */
  it('drops a battle older than the period', async () => {
    const { screen } = await board()
    await waitForText(screen, 'Today')

    // Ten days old: outside today and outside the week, inside all time.
    expect(shownText(screen)).not.toContain('Tam failed to conquer Old Mill')
    await screen.event('cycle-period', 'onPress')
    await Bun.sleep(1)
    expect(shownText(screen)).not.toContain('Tam failed to conquer Old Mill')

    await screen.event('cycle-period', 'onPress')
    await Bun.sleep(1)
    expect(shownText(screen)).toContain('Tam failed to conquer Old Mill')
    expect(shownText(screen)).toContain('Defended')
  })

  it('says plainly when nothing has been fought over', async () => {
    const { screen } = await board(null, { success: true, battles: [] })
    await waitForText(screen, 'Nobody has fought over anything today.')

    expect(visibility(screen, 'battles-empty')).toBe('flex')
  })

  it('opens the contested zone on the web', async () => {
    const { screen } = await board()
    await waitForText(screen, 'Marta is attacking Balboa Loop')

    await screen.event('battle-row', 'onPress')
    await Bun.sleep(0)
    expect(screen.sent.at(-1)?.type).toBe('NAVIGATE_OPEN')
    expect(String(screen.sent.at(-1)?.payload?.path ?? '')).toStartWith('/territory/')
  })

  it('reports a feed it could not load, and shows no battles', async () => {
    const { screen } = await board(null, null)
    await waitForText(screen, 'Could not load the battle feed')

    expect(visibility(screen, 'battles-body')).toBe('none')
    expect(visibility(screen, 'battles-error')).toBe('flex')
  })
})

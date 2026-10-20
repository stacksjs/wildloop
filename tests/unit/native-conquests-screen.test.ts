import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeKeychain, answer, compileNativeBundle, requests, segmentChosen, shownText, start, visibility, waitForRequest, waitForText, waitForVisibility } from '../fixtures/nativeScreen'

/**
 * The athlete's own record in the territory game, natively.
 *
 * Fourteenth screen. What it pins: it asks `?mine=1` rather than folding a
 * record out of the global feed, it speaks in the second person where the
 * battles feed speaks in the third, it counts only battles the athlete was
 * actually in, and ground of theirs being taken right now is on top.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Conquests.stx'), 'utf8')

const ME = 12
const RIVAL = 44

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

const OWN = {
  success: true,
  battles: [
    // Theirs, lost to Marta.
    { id: 1, territory_id: 7, territoryName: 'Balboa Loop', attacker_id: RIVAL, attackerName: 'Marta', defender_id: ME, defenderName: 'Glenn', status: 'conquered', areaCaptured: 1200, created_at: '2026-10-14T07:00:00.000Z' },
    // Theirs, held.
    { id: 2, territory_id: 8, territoryName: 'Switchback Ridge', attacker_id: RIVAL, attackerName: 'Marta', defender_id: ME, defenderName: 'Glenn', status: 'defended', areaCaptured: 0, created_at: '2026-10-13T07:00:00.000Z' },
    // Theirs, an attack that landed.
    { id: 3, territory_id: 9, territoryName: 'Old Mill', attacker_id: ME, attackerName: 'Glenn', defender_id: RIVAL, defenderName: 'Marta', status: 'conquered', areaCaptured: 50_000, created_at: '2026-10-12T07:00:00.000Z' },
    // Theirs, being taken right now.
    { id: 4, territory_id: 10, territoryName: 'Cedar Spur', attacker_id: RIVAL, attackerName: 'Marta', defender_id: ME, defenderName: 'Glenn', status: 'active', areaCaptured: 0, created_at: '2026-10-15T07:00:00.000Z' },
    /*
     * Not theirs at all. `?mine=1` finds battles through the territories an
     * athlete has fought over, so a later fight between two other people on
     * land this one once held is in those rows — the action filters it, and
     * the client does not rely on that having happened.
     */
    { id: 5, territory_id: 7, territoryName: 'Balboa Loop', attacker_id: 90, attackerName: 'Rui', defender_id: 91, defenderName: 'Ada', status: 'conquered', areaCaptured: 4000, created_at: '2026-10-11T07:00:00.000Z' },
  ],
}

async function board(token: string | null = 'tok_abc', payload: unknown = OWN) {
  const screen = await start('Conquests', {}, undefined, {}, nativeKeychain(token === null ? null : ME, token ?? undefined))
  if (token === null)
    return { screen }

  const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
  answer(screen, me, ok({ success: true, user: { id: ME } }))
  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/territories/battles'))
  answer(screen, request, payload === null ? { status: 500, statusText: 'Server Error', headers: {}, body: '{}' } : ok(payload))
  return { screen, request }
}

describe('Wildloop native conquests screen', () => {
  beforeAll(compileNativeBundle, 30000)

  it('renders its lists through the portable keyed boundary', () => {
    for (const list of ['battle in threatened()', 'battle in shown()'])
      expect(SOURCE).toContain(`:for="${list}"`)
    expect(SOURCE).not.toContain('<FlatList')
  })

  /*
   * `?mine=1`, not the global feed. Folded from the feed, a record counted
   * only the battles still among the newest 200 anyone fought — which is how
   * the web page came to report the same three conquests for everybody.
   */
  it('asks for the athlete\'s own battles, all of them', async () => {
    const { request } = await board()

    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/territories/battles?limit=1000&mine=1')
    expect(request.payload.args[0].headers.authorization).toBe('Bearer tok_abc')
  })

  /*
   * The app needs an account, so a signed-out viewer never reads this screen:
   * it asks the server for nothing and sends them to Login, naming itself so
   * they come back here once they have signed in.
   */
  it('sends a viewer with no account to Login without asking the server anything', async () => {
    const { screen } = await board(null)
    for (let attempt = 0; attempt < 60 && !screen.sent.some((m: any) => m.type === 'NAVIGATE_OPEN'); attempt++)
      await Bun.sleep(1)
    expect(screen.sent.some((m: any) => m.type === 'NAVIGATE_OPEN' && m.payload.path === '/login?next=%2Fconquests')).toBe(true)
    expect(requests(screen).filter((r: any) => r.payload?.module === 'Network')).toHaveLength(0)
  })

  /*
   * The second person, where the battles feed uses the third. The same battle
   * the feed calls "Rui conquered X" reads "Marta took ground from you at X"
   * here — the two web pages used to get this wrong in opposite directions.
   */
  it('speaks to the athlete, from their side of each battle', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, 'Marta took ground from you at Balboa Loop')

    expect(texts).toContain('You held off Marta at Switchback Ridge')
    expect(texts).toContain('You took ground from Marta at Old Mill')
    expect(texts).toContain('Marta is attacking Cedar Spur')
  })

  /*
   * The same row the feed badges "Conquered" is "Lost" to whoever held it.
   *
   * Waits on a battle line rather than on "Lost": that word is also the label
   * over the lost-zone counter, so it is in the first RENDER whatever the
   * badges say, and waiting on it passes before the list exists.
   */
  it('badges a loss as a loss, not as a conquest', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, 'Marta took ground from you at Balboa Loop')

    expect(texts).toContain('Lost')
    expect(texts).toContain('Defended')
    expect(texts).toContain('Conquered')
    expect(texts).toContain('Under attack')
  })

  it('counts the record from the battles themselves', async () => {
    const { screen } = await board()
    await waitForText(screen, 'Marta took ground from you at Balboa Loop')

    // One attack landed, for five hectares — not the nine that would show if
    // Rui and Ada's fight were counted as this athlete's.
    expect(shownText(screen)).toContain('Taken')
    expect(shownText(screen)).toContain('5.00 ha')
  })

  /*
   * A battle between two other athletes must not appear under "Your battles",
   * however it arrived. "All" used to list every battle in the game here, each
   * labelled as though the player had been on one side of it.
   */
  it('leaves out a battle the athlete was not in', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, 'Marta took ground from you at Balboa Loop')

    expect(texts.some(text => text.includes('Rui'))).toBe(false)
    expect(texts.some(text => text.includes('Ada'))).toBe(false)
  })

  /*
   * Ground being taken right now is the only thing on this screen the athlete
   * can still act on, so it is above the counters.
   *
   * Read off the source rather than off `shownText`, whose order is the order
   * operations arrived in — a `:for` inside a `:show` is populated by a later
   * batch, so the threat rows trail the statically-present counter labels
   * however the markup is arranged.
   */
  it('puts ground being taken right now on top', async () => {
    const { screen } = await board()
    await waitForText(screen, '1 zone under attack')

    expect(visibility(screen, 'conquests-threat')).toBe('flex')
    expect(SOURCE.indexOf('testID="conquests-threat"')).toBeLessThan(SOURCE.indexOf('testID="record-taken"'))
  })

  it('hides the threat panel when nothing of theirs is contested', async () => {
    const { screen } = await board('tok_abc', { success: true, battles: OWN.battles.slice(0, 3) })
    await waitForText(screen, 'Marta took ground from you at Balboa Loop')

    expect(visibility(screen, 'conquests-threat')).toBe('none')
  })

  it('changes filter without going back to the server', async () => {
    const { screen } = await board()
    await waitForText(screen, 'All')

    const before = requests(screen).length
    await screen.event('conquests-filter-attacks', 'onPress')
    await Bun.sleep(1)

    expect(requests(screen).length).toBe(before)
    expect(segmentChosen(screen, 'conquests-filter-attacks')).toBe(true)
  })

  /*
   * "Attacks" is the one battle the athlete started. Under "All" every one of
   * the four is theirs, so a filter that did nothing would still look right —
   * this checks the three they did not start are gone.
   */
  it('shows only the athlete\'s own attacks under that filter', async () => {
    const { screen } = await board()
    await waitForText(screen, 'All')

    await screen.event('conquests-filter-attacks', 'onPress')
    await Bun.sleep(1)

    const texts = shownText(screen)
    expect(texts).toContain('You took ground from Marta at Old Mill')
    expect(texts).not.toContain('Marta took ground from you at Balboa Loop')
    expect(texts).not.toContain('You held off Marta at Switchback Ridge')
  })

  it('says something when a filter is empty', async () => {
    const { screen } = await board('tok_abc', { success: true, battles: [OWN.battles[2]] })
    await waitForText(screen, 'You took ground from Marta at Old Mill')

    // Defences: the athlete has none in this payload.
    await screen.event('conquests-filter-defenses', 'onPress')
    await waitForVisibility(screen, 'conquests-empty', 'flex')

    expect(shownText(screen)).toContain('Nobody has come for your ground yet.')
  })

  it('opens a battle\'s zone on the web', async () => {
    const { screen } = await board()
    await waitForText(screen, 'Marta took ground from you at Balboa Loop')

    await screen.event('conquest-row', 'onPress')
    await Bun.sleep(0)
    expect(screen.sent.at(-1)?.type).toBe('NAVIGATE_OPEN')
    expect(String(screen.sent.at(-1)?.payload?.path ?? '')).toStartWith('/territory/')
  })

  it('reports a record it could not load, and shows no numbers', async () => {
    const { screen } = await board('tok_abc', null)
    await waitForText(screen, 'Could not load your record')

    expect(visibility(screen, 'conquests-body')).toBe('none')
    expect(visibility(screen, 'conquests-error')).toBe('flex')
  })
})

import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeKeychain, answer, compileNativeBundle, requests, waitForGeometry, shownText, start, visibility, waitForRequest, waitForText, waitForVisibility } from '../fixtures/nativeScreen'
import { territoryIdFrom } from '../../resources/functions/territories'

/**
 * One territory, natively.
 *
 * Fifteenth screen, and the first that takes a route parameter. What it pins:
 * the id comes from `craft.route.params` and is asked for by that id, a
 * parameter that is not a number loads nothing rather than territory zero, a
 * 404 reads as "no such territory" rather than as a failure, the boundary
 * reaches the host closed, and the history speaks in the third voice —
 * relative to the ground the reader is already looking at.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/TerritoryDetail.stx'), 'utf8')

const ME = 12
const RIVAL = 44

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

const TERRITORY = {
  territory: {
    properties: {
      id: 7,
      name: 'Balboa Loop',
      ownerId: ME,
      ownerName: 'Glenn',
      areaSize: 240_000,
      conquestCount: 2,
      defendCount: 5,
      claimedAt: '2026-10-01T07:00:00.000Z',
      status: 'contested',
      centerLat: 32.73,
      centerLng: -117.15,
    },
    geometry: { type: 'Polygon', coordinates: [[[-117.16, 32.72], [-117.14, 32.72], [-117.14, 32.74]]] },
  },
}

const FEED = {
  battles: [
    { id: 1, territory_id: 7, territoryName: 'Balboa Loop', attacker_id: RIVAL, attackerName: 'Marta', defender_id: ME, defenderName: 'Glenn', status: 'active', areaCaptured: 0, created_at: '2026-10-15T07:00:00.000Z' },
    { id: 2, territory_id: 7, territoryName: 'Balboa Loop', attacker_id: 90, attackerName: 'Rui', defender_id: ME, defenderName: 'Glenn', status: 'defended', areaCaptured: 0, created_at: '2026-10-13T07:00:00.000Z' },
    // Another zone's fight, which must not appear on this page.
    { id: 3, territory_id: 99, territoryName: 'Switchback Ridge', attacker_id: 91, attackerName: 'Ada', defender_id: 92, defenderName: 'Joe', status: 'conquered', areaCaptured: 500, created_at: '2026-10-16T07:00:00.000Z' },
  ],
}

/** Start on an id, answer the keychain, `/api/me`, the territory and the feed. */
async function open(id: unknown = '7', territory: unknown = TERRITORY, status = 200) {
  const screen = await start('TerritoryDetail', { id }, undefined, {}, nativeKeychain(ME, 'tok_abc'))

  /*
   * A parameter that cannot be a territory does no I/O at all — the screen
   * decides before it reads the keychain, so there is not even a
   * SecureStorage request to answer here.
   */
  if (territoryIdFrom(id) === null)
    return { screen }

  const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
  answer(screen, me, ok({ success: true, user: { id: ME } }))

  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/territories/'))
  if (status !== 200) {
    answer(screen, request, { status, statusText: 'No', headers: {}, body: '{}' })
    return { screen, request }
  }
  answer(screen, request, ok(territory))

  const feed = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/territories/battles'))
  answer(screen, feed, ok(FEED))
  return { screen, request, feed }
}

function geometries(screen: any): number[][] {
  return screen.sent
    .filter((message: any) => message.type === 'MUTATE')
    .flatMap((message: any) => message.payload.operations)
    .filter((op: any) => op.op === 'updateNode' && op.patch?.props?.geometry)
    .map((op: any) => op.patch.props.geometry)
}

describe('Wildloop native territory detail screen', () => {
  beforeAll(compileNativeBundle, 30000)

  it('renders its history through the portable keyed boundary', () => {
    expect(SOURCE).toContain(':for="battle in history()"')
    expect(SOURCE).not.toContain('<FlatList')
  })

  it('asks for the territory the route named', async () => {
    const { request } = await open('7')

    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/territories/7')
    expect(request.payload.args[0].headers.authorization).toBe('Bearer tok_abc')
  })

  /*
   * The web page uses -1 as its sentinel for exactly this: territory 1 is a
   * real zone, and loading it because a parameter failed to parse is worse
   * than saying nothing was found.
   */
  it('loads nothing at all for a parameter that is not a territory', async () => {
    for (const id of ['', 'abc', '0', '-3', '7.5.1', 'NaN']) {
      const { screen } = await open(id)
      // Name the id in any failure: five sessions in one test, and "it is
      // none" says nothing about which parameter produced it.
      try {
      // Not `waitForText('No such territory')`: that label is in the first
      // RENDER whatever happens, so it returns before the screen has decided.
        await waitForVisibility(screen, 'detail-missing', 'flex')
      }
      catch (cause) {
        throw new Error(`id ${JSON.stringify(id)}: ${cause instanceof Error ? cause.message : String(cause)}`)
      }

      // Nothing at all: no network, and no keychain read either.
      expect(requests(screen)).toHaveLength(0)
      expect(visibility(screen, 'detail-body')).toBe('none')
    }
  })

  /*
   * The parameter missing entirely, which is what an id of `undefined` really
   * means — the shell bound nothing. Tested through `start` rather than the
   * helper above, whose `id = '7'` default would swallow it and quietly load
   * territory 7 instead; it did, and the failure looked like a screen bug.
   */
  it('loads nothing when the route bound no id at all', async () => {
    const screen = await start('TerritoryDetail', {})
    await waitForVisibility(screen, 'detail-missing', 'flex')

    expect(requests(screen)).toHaveLength(0)
    expect(visibility(screen, 'detail-body')).toBe('none')
  })

  /* A zone that does not exist is an answer, not a failure to load. */
  it('reads a 404 as no such territory rather than an error', async () => {
    const { screen } = await open('7', TERRITORY, 404)
    await waitForVisibility(screen, 'detail-missing', 'flex')

    expect(visibility(screen, 'detail-error')).toBe('none')
  })

  it('reports a territory it genuinely could not load', async () => {
    const { screen } = await open('7', TERRITORY, 500)
    await waitForVisibility(screen, 'detail-error', 'flex')

    expect(shownText(screen)).toContain('Could not load this territory')
    expect(visibility(screen, 'detail-missing')).toBe('none')
  })

  it('names the zone, its holder and where it stands', async () => {
    const { screen } = await open()
    await waitForVisibility(screen, 'detail-body', 'flex')
    const texts = await waitForText(screen, 'Balboa Loop')

    expect(texts).toContain('Held by you')
    expect(texts).toContain('Your territory')
    expect(texts).toContain('Contested')
    expect(texts).toContain('24.0 ha')
  })

  it('offers the action that fits whose ground it is', async () => {
    const { screen } = await open()
    await waitForText(screen, 'Balboa Loop')
    expect(shownText(screen)).toContain('Defend it')

    const theirs = { territory: { ...TERRITORY.territory, properties: { ...TERRITORY.territory.properties, ownerId: RIVAL, ownerName: 'Marta' } } }
    const other = await open('7', theirs)
    await waitForText(other.screen, 'Balboa Loop')

    expect(shownText(other.screen)).toContain('Conquer this')
    expect(shownText(other.screen)).toContain('Held by Marta')
  })

  it('hands the boundary to the host closed', async () => {
    const { screen } = await open()
    await waitForVisibility(screen, 'detail-map-frame', 'flex')

    const [drawn] = await waitForGeometry(screen)
    expect(drawn).toBeDefined()
    expect(drawn.slice(0, 2)).toEqual(drawn.slice(-2))
    // [lat, lng], not GeoJSON's [lng, lat].
    expect(Math.abs(drawn[0])).toBeLessThanOrEqual(90)
    expect(Math.abs(drawn[1])).toBeGreaterThan(90)
  })

  it('draws no map for a zone with no boundary', async () => {
    const flat = { territory: { ...TERRITORY.territory, geometry: null } }
    const { screen } = await open('7', flat)
    await waitForText(screen, 'Balboa Loop')

    // The binding still fires; it carries an empty array, and the frame stays
    // hidden. An assertion that no geometry op exists at all would pass for
    // the wrong reason — the op is there either way.
    expect(geometries(screen).every(g => g.length === 0)).toBe(true)
    expect(visibility(screen, 'detail-map-frame')).toBe('none')
  })

  /*
   * The third voice. The feed would say "Marta is attacking Balboa Loop";
   * on the zone's own page that reads as a stutter.
   */
  it('tells the history relative to the ground, not by name', async () => {
    const { screen } = await open()
    const texts = await waitForText(screen, 'Marta is attacking it')

    expect(texts).toContain('Rui was held off')
    expect(texts.some(text => text.includes('is attacking Balboa Loop'))).toBe(false)
  })

  it('leaves another zone\'s battles off this page', async () => {
    const { screen } = await open()
    const texts = await waitForText(screen, 'Marta is attacking it')

    expect(texts.some(text => text.includes('Ada'))).toBe(false)
    expect(texts.some(text => text.includes('Switchback'))).toBe(false)
  })

  it('says so when nobody has fought over the ground', async () => {
    const screen = await start('TerritoryDetail', { id: '7' })
    const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
    answer(screen, keychain, 'tok_abc')
    const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
    answer(screen, me, ok({ success: true, user: { id: ME } }))
    const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/territories/7'))
    answer(screen, request, ok(TERRITORY))
    const feed = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/battles'))
    answer(screen, feed, ok({ battles: [] }))

    await waitForText(screen, 'Nobody has fought over this ground yet.')
    expect(visibility(screen, 'detail-history')).toBe('none')
  })

  /*
   * A feed that fails costs the history and not the territory — the zone is
   * already loaded by then, and losing it to a second request would be worse
   * than showing it without its past.
   */
  it('keeps the territory when its history cannot be loaded', async () => {
    const screen = await start('TerritoryDetail', { id: '7' })
    const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
    answer(screen, keychain, 'tok_abc')
    const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
    answer(screen, me, ok({ success: true, user: { id: ME } }))
    const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/territories/7'))
    answer(screen, request, ok(TERRITORY))
    const feed = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/battles'))
    answer(screen, feed, { status: 500, statusText: 'No', headers: {}, body: '{}' })

    await waitForText(screen, 'Balboa Loop')
    expect(visibility(screen, 'detail-body')).toBe('flex')
    expect(visibility(screen, 'detail-error')).toBe('none')
  })

  it('pushes the holder\'s page, and opens the recorder', async () => {
    const { screen } = await open()
    await waitForVisibility(screen, 'detail-owner', 'flex')

    /*
     * Searched rather than read off the end: a tap can be followed by render
     * operations, so `sent.at(-1)` is not reliably the navigation.
     */
    const opened = () => screen.sent.filter((m: any) => m.type === 'NAVIGATE_OPEN').map((m: any) => String(m.payload?.path ?? ''))

    /* The holder's page is native now, so it is pushed rather than opened. */
    await screen.event('detail-owner', 'onPress')
    await Bun.sleep(1)
    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE')).toContainEqual(
      expect.objectContaining({ payload: expect.objectContaining({ screen: 'AthleteDetail', params: { id: String(ME) } }) }),
    )

    await screen.event('territory-action', 'onPress')
    await Bun.sleep(1)
    expect(opened()).toContain('/record')
  })

  it('offers the way back to the map when there is nothing to show', async () => {
    const { screen } = await open('nope')
    await waitForVisibility(screen, 'detail-missing', 'flex')

    await screen.event('back-to-territories', 'onPress')
    await Bun.sleep(1)
    expect(screen.sent.filter((m: any) => m.type === 'NAVIGATE')).toContainEqual(
      expect.objectContaining({ type: 'NAVIGATE', payload: expect.objectContaining({ screen: 'Territories' }) }),
    )
  })
})

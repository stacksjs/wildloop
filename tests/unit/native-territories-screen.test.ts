import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, requests, shownText, start, visibility, waitForRequest, waitForText } from '../fixtures/nativeScreen'

/**
 * The territory map, natively.
 *
 * Twelfth screen, and the first to draw a real map. What it pins: a zone's
 * boundary reaches the host as a closed flat array on a `MapPolyline` — the
 * thing stacksjs/stx#2073 wrongly said was dropped — the GeoJSON ring is
 * reordered on the way in, the filter changes without going back to the
 * server, and a zone the athlete does not own is named as somebody else's.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Territories.stx'), 'utf8')

const ME = 12

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

const MAP = {
  features: [
    {
      properties: {
        id: 1,
        name: 'Balboa Loop',
        ownerId: ME,
        ownerName: 'Glenn',
        areaSize: 240_000,
        conquestCount: 2,
        defendCount: 5,
        claimedAt: '2026-10-01T07:00:00.000Z',
        status: 'active',
        centerLat: 32.73,
        centerLng: -117.15,
      },
      // GeoJSON order: [lng, lat]. The screen must hand the host [lat, lng].
      geometry: { type: 'Polygon', coordinates: [[[-117.16, 32.72], [-117.14, 32.72], [-117.14, 32.74]]] },
    },
    {
      properties: {
        id: 2,
        name: 'Switchback Ridge',
        ownerId: 44,
        ownerName: 'Marta',
        areaSize: 900_000,
        conquestCount: 0,
        defendCount: 1,
        claimedAt: '2026-10-02T07:00:00.000Z',
        status: 'contested',
        centerLat: 32.80,
        centerLng: -117.20,
      },
      geometry: { type: 'Polygon', coordinates: [[[-117.21, 32.79], [-117.19, 32.79], [-117.19, 32.81]]] },
    },
  ],
}

async function board(token: string | null = 'tok_abc', payload: unknown = MAP) {
  const screen = await start('Territories')
  const keychain = await waitForRequest(screen, 0, r => r.payload?.module === 'SecureStorage')
  answer(screen, keychain, token)
  if (token === null)
    return { screen }

  const me = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
  answer(screen, me, ok({ success: true, user: { id: ME } }))
  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network' && r.payload.args[0].url.includes('/api/territories/map'))
  answer(screen, request, payload === null ? { status: 500, statusText: 'Server Error', headers: {}, body: '{}' } : ok(payload))
  return { screen, request }
}

/** Every `updateNode` patch that carried a geometry, in order. */
function geometries(screen: any): number[][] {
  return screen.sent
    .filter((message: any) => message.type === 'MUTATE')
    .flatMap((message: any) => message.payload.operations)
    .filter((op: any) => op.op === 'updateNode' && op.patch?.props?.geometry)
    .map((op: any) => op.patch.props.geometry)
}

describe('Wildloop native territories screen', () => {
  beforeAll(compileNativeBundle)

  it('renders its lists through the portable keyed boundary', () => {
    for (const list of ['shape in shapes()', 'row in shown()', 'holder in holders()'])
      expect(SOURCE).toContain(`:for="${list}"`)
    expect(SOURCE).not.toContain('<FlatList')
  })

  it('draws zones as polylines, because there is no polygon primitive', () => {
    expect(SOURCE).toContain('<mappolyline')
    expect(SOURCE).toContain(':geometry="shape.geometry"')
    expect(SOURCE).not.toContain('<mappolygon')
  })

  it('asks for the territory map with the athlete\'s token', async () => {
    const { request } = await board()

    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/territories/map?limit=500')
    expect(request.payload.args[0].headers.authorization).toBe('Bearer tok_abc')
  })

  it('asks for nothing at all when nobody is signed in', async () => {
    const { screen } = await board(null)
    await waitForText(screen, 'Sign in on the web to see your territory.')

    expect(requests(screen).filter((r: any) => r.payload?.module === 'Network')).toHaveLength(0)
    expect(visibility(screen, 'territories-body')).toBe('none')
  })

  /*
   * The whole point of the screen. A bound `:geometry` is absent from the
   * initial RENDER and arrives in a later batch — reading only the render is
   * what produced the bad filing (stacksjs/stx#2073), so this reads the
   * operations.
   */
  it('hands each zone\'s boundary to the host as a flat array', async () => {
    const { screen } = await board()
    await waitForText(screen, 'Balboa Loop')

    const drawn = geometries(screen)
    expect(drawn.length).toBeGreaterThanOrEqual(2)
    expect(drawn.every(geometry => geometry.length % 2 === 0)).toBe(true)
  })

  /*
   * A ring arrives as [lng, lat] and must reach the host as [lat, lng]. Read
   * backwards a San Diego zone sits at latitude -117, which is not a latitude,
   * and nothing in the stack complains.
   */
  it('reorders the ring, so the zone is not in the Indian Ocean', async () => {
    const { screen } = await board()
    await waitForText(screen, 'Balboa Loop')

    const [first] = geometries(screen)
    for (let index = 0; index < first.length; index += 2) {
      expect(Math.abs(first[index])).toBeLessThanOrEqual(90)
      expect(Math.abs(first[index + 1])).toBeGreaterThan(90)
    }
  })

  /* A polyline is only a polygon if it comes back to where it started. */
  it('closes each zone, since a polyline is not a polygon', async () => {
    const { screen } = await board()
    await waitForText(screen, 'Balboa Loop')

    for (const geometry of geometries(screen)) {
      expect(geometry.slice(0, 2)).toEqual(geometry.slice(-2))
    }
  })

  it('changes filter without going back to the server', async () => {
    const { screen } = await board()
    await waitForText(screen, 'All')

    const before = requests(screen).length
    await screen.event('cycle-filter', 'onPress')
    await Bun.sleep(1)

    expect(requests(screen).length).toBe(before)
    expect(shownText(screen)).toContain('Mine')
  })

  it('names whose ground each zone is', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, 'Balboa Loop')

    expect(texts).toContain('Switchback Ridge')
    expect(texts).toContain('You')
    expect(texts).toContain('Marta')
  })

  it('ranks the holders by the ground they hold', async () => {
    const { screen } = await board()
    const texts = await waitForText(screen, '1 zone held')

    // Marta holds 900,000 m² to the viewer's 240,000, so she leads. One
    // decimal above a hectare: `formatTerritoryArea` picks the unit, and the
    // precision, for the magnitude.
    expect(texts).toContain('90.0 ha')
    expect(texts).toContain('24.0 ha')
  })

  it('opens a zone\'s page on the web, where it lives', async () => {
    const { screen } = await board()
    await waitForText(screen, 'Balboa Loop')

    await screen.event('territory-row', 'onPress')
    await Bun.sleep(0)
    expect(screen.sent.at(-1)?.type).toBe('NAVIGATE_OPEN')
    expect(String(screen.sent.at(-1)?.payload?.path ?? '')).toStartWith('/territory/')
  })

  it('reports a map it could not load, and shows no zones', async () => {
    const { screen } = await board('tok_abc', null)
    await waitForText(screen, 'Could not load the territory map')

    expect(visibility(screen, 'territories-body')).toBe('none')
    expect(visibility(screen, 'territories-error')).toBe('flex')
  })

  it('draws nothing for a zone whose feature carried no boundary', async () => {
    const { screen } = await board('tok_abc', {
      features: [{ properties: { id: 7, name: 'Unmapped', ownerId: ME, ownerName: 'Glenn', status: 'active' }, geometry: null }],
    })
    await waitForText(screen, 'Unmapped')

    expect(geometries(screen)).toEqual([])
    expect(visibility(screen, 'territory-map-frame')).toBe('none')
  })
})

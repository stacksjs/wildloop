import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, chooseNativeOption, nativeNodeProps, nativeNodeStyle, compileNativeBundle, nativeBundle, nodesByTestId, requests, shownText, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'
import { trailPlaceLine, trailRoutePoints, trailStatsLine } from '../../resources/functions/trails'

/**
 * The trail catalog, natively.
 *
 * Sixth list screen, and the first that draws something. What it pins: the
 * route reaches the screen as a bound `:points` on a real SVG polyline, the
 * numbers come from the shared module rather than the template, searching goes
 * back to the server, and a row opens the native trail detail screen.
 *
 * It also pins the shape of the row thumbnail. This screen draws its line as
 * an SVG polyline because the row is 96x64, not because a `Map` could not be
 * fed — it can. If a row ever becomes a real map, these assertions are the
 * ones to rewrite deliberately.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Trails.stx'), 'utf8')

const LINE = [[45.64, -121.92], [45.66, -121.9], [45.64, -121.92]]

const TRAILS = {
  trails: [
    {
      id: 7,
      name: 'Eagle Creek Loop',
      location: 'Columbia River Gorge, Oregon',
      latitude: 45.64,
      longitude: -121.92,
      distance: 12.4,
      elevation: 1680,
      difficulty: 'hard',
      routeType: 'loop',
      managedBy: 'Mount Hood National Forest',
      geometry: JSON.stringify(LINE),
    },
    {
      id: 8,
      name: 'Dog Mountain',
      location: 'Cascade Locks, Washington',
      latitude: 45.69,
      longitude: -121.7,
      distance: 6.9,
      elevation: 2800,
      difficulty: 'hard',
      routeType: 'out-and-back',
      managedBy: '',
      geometry: null,
    },
  ],
  meta: { total: 412, hasMore: true },
}

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

async function catalog() {
  const screen = await start('Trails')
  const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
  return { screen, request }
}

describe('Wildloop native trails screen', () => {
  beforeAll(compileNativeBundle, 30000)

  it('renders the list through the portable keyed boundary', () => {
    expect(SOURCE).toContain(':for="row in rows()" :key="row.id"')
    expect(SOURCE).not.toContain('<FlatList')
  })

  /*
   * The lightweight row thumbnail carries this trail's recorded line through
   * a bound SVG polyline. Full trail screens use native Maps.
   */
  it('binds the route as geometry the compiler actually keeps', () => {
    expect(SOURCE).toContain(':points="line(row)"')
    expect(nativeBundle()).toContain('"Polyline"')
    expect(nativeBundle()).toContain(':points')
  })

  it('labels native collection and difficulty controls and sends the selected filter', async () => {
    const { screen, request } = await catalog()
    answer(screen, request, ok(TRAILS))
    await waitForText(screen, 'Eagle Creek Loop')
    expect(nativeNodeProps(screen, 'trails-list').title).toBe('Trail collection: All trails')
    expect(nativeNodeStyle(screen, 'trails-list').minHeight).toBe(44)
    expect(nativeNodeProps(screen, 'trails-search').accessibilityLabel).toBe('Search trails')
    expect(nativeNodeProps(screen, 'trails-search').placeholder).toBe('Name, park or forest')
    const before = requests(screen).length
    await chooseNativeOption(screen, 'trails-difficulty', 'Hard')
    const filtered = await waitForRequest(screen, before, r => r.payload.module === 'Network')
    expect(filtered.payload.args[0].url).toContain('difficulty=hard')
    expect(nativeNodeProps(screen, 'trails-difficulty').title).toBe('Difficulty: Hard')
  })

  it('asks the public catalog, and sends no token', async () => {
    const { request } = await catalog()

    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/trails?limit=30&offset=0')
    // Its own page size, not the website's 60: a phone row is taller.
    expect(request.payload.args[0].headers.authorization).toBeUndefined()
  })

  it('shows each trail with the numbers the shared module computes', async () => {
    const { screen, request } = await catalog()
    answer(screen, request, ok(TRAILS))
    const texts = await waitForText(screen, 'Eagle Creek Loop')

    const [first] = TRAILS.trails
    expect(texts).toContain(trailPlaceLine(first as any))
    expect(texts).toContain('12 mi · 1,680 ft · Loop')
    expect(texts).toContain(trailStatsLine({ distance: 12.4, elevation: 1680, routeType: 'loop' } as any))
    expect(nodesByTestId(screen.sent.find((m: any) => m.type === 'RENDER')?.payload.document).has('trails-scroll')).toBe(true)
  })

  it('says how much of the catalog is on screen', async () => {
    const { screen, request } = await catalog()
    answer(screen, request, ok(TRAILS))
    const texts = await waitForText(screen, 'Eagle Creek Loop')

    expect(texts).toContain('2 of 412 trails')
  })

  /*
   * A trail the catalog holds no line for gets the words alone. The web card
   * falls back to a mountain glyph; a row here simply has no picture, which is
   * the same statement with less furniture.
   */
  it('draws a line only for the trail that has one', async () => {
    const { screen, request } = await catalog()
    answer(screen, request, ok(TRAILS))
    await waitForText(screen, 'Dog Mountain')

    expect(trailRoutePoints(LINE as any)).not.toBe('')
    expect(trailRoutePoints(null)).toBe('')
    expect(shownText(screen)).toContain('Dog Mountain')
  })

  it('searches on the server, not in the rows it already has', async () => {
    const { screen, request } = await catalog()
    answer(screen, request, ok(TRAILS))
    await waitForText(screen, 'Eagle Creek Loop')

    const before = requests(screen).length
    await screen.event('trails-search', 'onChangeText', { text: 'eagle creek' })
    await screen.event('trails-submit', 'onPress')
    const second = await waitForRequest(screen, before, r => r.payload?.module === 'Network')

    expect(second.payload.args[0].url).toContain('q=eagle%20creek')
  })

  it('opens the native trail detail path for a row', async () => {
    const { screen, request } = await catalog()
    answer(screen, request, ok(TRAILS))
    await waitForText(screen, 'Eagle Creek Loop')

    // The fixture resolves a repeated testID to the last node that carries it,
    // so this taps the second row — Dog Mountain, id 8 — and the assertion
    // names the row that was actually tapped rather than the one listed first.
    await screen.event('trail-row', 'onPress')
    await Bun.sleep(0)
    expect(screen.sent.at(-1)).toMatchObject({ type: 'NAVIGATE_OPEN', payload: { path: '/trail/8' } })
  })

  it('says so when nothing matches, rather than showing an empty list', async () => {
    const { screen, request } = await catalog()
    answer(screen, request, ok({ trails: [], meta: { total: 0 } }))

    await waitForText(screen, 'No trail matches that.')
  })

  it('reports a catalog it could not load', async () => {
    const { screen, request } = await catalog()
    answer(screen, request, { status: 500, statusText: 'Server Error', headers: {}, body: '{}' })

    await waitForText(screen, 'Could not load trails')
  })
})

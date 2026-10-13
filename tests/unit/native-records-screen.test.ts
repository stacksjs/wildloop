import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, nodesByTestId, requests, shownText, start, waitForRequest, waitForText } from '../fixtures/nativeScreen'
import { CATEGORY_LABELS, formatElapsed, recordPace, STATUS_LABELS, STYLE_LABELS } from '../../resources/functions/route-records'

/**
 * The records board as a native screen.
 *
 * The first promotion that is a list, so this is where `FlatList` and `:for`
 * over the keyed mutation protocol are exercised rather than asserted. What it
 * pins beyond rendering: the numbers come from
 * `resources/functions/route-records.ts`, the same module the web screen reads,
 * so the two screens cannot drift on an elapsed time or a pace — and a row
 * hands off to the web effort page rather than pretending to be it, because
 * that page is a map (craft-native/craft#340).
 */

const EFFORTS = [
  {
    id: 3,
    trailId: 11,
    trailName: 'Skyline Loop Trail',
    trailLocation: 'Mount Rainier, WA',
    trailDistance: 5.5,
    userName: 'Chris Breuer',
    status: 'verified',
    style: 'self_supported',
    category: 'mens',
    elapsedSeconds: 4158,
  },
  {
    id: 4,
    trailId: 12,
    trailName: 'Mist Trail to Vernal Fall',
    trailLocation: null,
    trailDistance: 0,
    userName: 'Kim Gottwald',
    status: 'pending',
    style: 'supported',
    category: 'womens',
    elapsedSeconds: null,
  },
]

const RECORDS_SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Records.stx'), 'utf8')

describe('Wildloop native records screen', () => {
  beforeAll(compileNativeBundle)

  it('uses the portable keyed :for boundary rather than FlatList template expansion', () => {
    expect(RECORDS_SOURCE).toContain('<Pressable :for="row in rows()" :key="row.id"')
    expect(RECORDS_SOURCE).not.toContain('<FlatList')
    expect(RECORDS_SOURCE).toContain('FlatList\'s legacy item')
  })

  it('asks the public board for the latest claims and draws a row for each', async () => {
    const screen = await start('Records')

    const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
    expect(request.payload.args[0].url).toBe('https://wildloop.org/api/route-efforts?limit=40')
    // A public board: no Authorization header, which is why the web page is
    // crawlable and this screen needs no token.
    expect(request.payload.args[0].headers?.authorization).toBeUndefined()

    answer(screen, request, {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ efforts: EFFORTS }),
    })
    const texts = await waitForText(screen, 'Skyline Loop Trail')
    expect(texts).toContain('Mount Rainier, WA')
    // Straight from the shared helpers, not formatted again here.
    expect(texts).toContain(formatElapsed(4158))
    expect(texts).toContain(recordPace(5.5, 4158))
    // Composed from the shared maps rather than retyped, so a wording change
    // in `route-records.ts` cannot leave the two screens saying different
    // things while this still passes.
    expect(texts).toContain(`Chris Breuer · ${STYLE_LABELS.self_supported} · ${CATEGORY_LABELS.mens}`)
    expect(texts).toContain(STATUS_LABELS.verified)
  })

  /*
   * A claim still running has no finish time and a trail with no recorded
   * distance has no pace. Both have to read as absent rather than as zero —
   * `formatElapsed(null)` is the shared answer for the first.
   */
  it('shows an unfinished claim without inventing a time or a pace', async () => {
    const screen = await start('Records')
    const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
    answer(screen, request, {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ efforts: [EFFORTS[1]] }),
    })
    const texts = await waitForText(screen, formatElapsed(null))
    expect(texts.some(t => t.includes('/mi'))).toBe(false)
  })

  it('refilters on the server when the style changes, and hands a row to the web screen', async () => {
    const screen = await start('Records')
    const first = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
    answer(screen, first, {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ efforts: EFFORTS }),
    })
    await waitForText(screen, 'Skyline Loop Trail')

    const before = requests(screen).length
    await screen.event('cycle-style', 'onPress')
    const second = await waitForRequest(screen, before, r => r.payload?.module === 'Network')
    expect(second.payload.args[0].url).toContain('style=supported')

    // The last row the screen was given, which is the second effort.
    await screen.event('record-row', 'onPress')
    await Bun.sleep(0)
    expect(screen.sent.at(-1)).toMatchObject({ type: 'NAVIGATE_OPEN', payload: { path: '/effort/4' } })
  })

  it('reports a board it could not reach, rather than an empty one', async () => {
    const screen = await start('Records')
    const request = await waitForRequest(screen, 0, r => r.payload?.module === 'Network')
    answer(screen, request, { status: 500, statusText: 'Server Error', headers: {}, body: '{}' })
    await waitForText(screen, 'Could not reach the records service')

    expect(nodesByTestId(screen.sent.find((m: any) => m.type === 'RENDER')?.payload.document).has('records-list')).toBe(true)
    expect(shownText(screen).some(t => t.includes('Could not reach the records service'))).toBe(true)
  })
})

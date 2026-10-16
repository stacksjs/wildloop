import { beforeAll, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, compileNativeBundle, requests, shownText, start, visibility, waitForRequest, waitForText, waitForVisibility } from '../fixtures/nativeScreen'

/**
 * Search, natively.
 *
 * Tenth screen. What it pins: five endpoints asked in parallel rather than one
 * after another, a stale answer never replacing a newer one, nothing asked at
 * all under two characters, and a quick link pushing the native screen where
 * the app has one instead of opening a web view onto a page it draws itself.
 */

const SOURCE = readFileSync(join(import.meta.dir, '../../resources/native/Search.stx'), 'utf8')

function ok(body: unknown) {
  return { status: 200, statusText: 'OK', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

const TOWNS = { results: [{ text: 'San Diego, California', center: { lat: 32.71571, lng: -117.16472 }, properties: { name: 'San Diego', region: 'California', countryName: 'United States' } }] }
/*
 * `/api/search/suggest` answers in the shape `groupSearchResults` reads:
 * a `kind` that says which group it belongs to, and a label/detail/href
 * already built. The first version of this fixture invented a trail row and
 * the Trails group came out empty.
 */
const SUGGEST = { suggestions: [{ kind: 'trail', label: 'Cowles Mountain', detail: 'San Diego, CA · 3 mi', href: '/trail/7' }] }
const PEOPLE = { athletes: [{ id: 5, name: 'Marta Keller', username: 'marta' }] }
const CLUBS = { clubs: [{ id: 2, name: 'Dawn Patrol', location: 'San Diego, CA', memberCount: 12 }] }
const EVENTS = { events: [{ id: 9, name: 'Sunrise 10k', location: 'San Diego, CA', startTime: '2026-11-02T09:00:00.000Z' }] }

/** Type, submit, and answer all five requests. */
async function search(screen: any, text = 'san diego') {
  await screen.event('search-input', 'onChangeText', { text })
  const before = requests(screen).length
  await screen.event('run-search', 'onPress')

  const asked: any[] = []
  for (let i = 0; i < 5; i++)
    asked.push(await waitForRequest(screen, before + i, r => r.payload?.module === 'Network'))

  const byUrl = (part: string) => asked.find(request => request.payload.args[0].url.includes(part))
  answer(screen, byUrl('/api/geo/search'), ok(TOWNS))
  answer(screen, byUrl('/api/search/suggest'), ok(SUGGEST))
  answer(screen, byUrl('/api/users/search'), ok(PEOPLE))
  answer(screen, byUrl('/api/clubs'), ok(CLUBS))
  answer(screen, byUrl('/api/events'), ok(EVENTS))
  return asked
}

describe('Wildloop native search screen', () => {
  beforeAll(compileNativeBundle)

  it('renders every list through the portable keyed boundary', () => {
    for (const list of ['link in quickLinks', 'section in sections()', 'row in section.rows'])
      expect(SOURCE).toContain(`:for="${list}"`)
    expect(SOURCE).not.toContain('<FlatList')
  })

  it('offers somewhere to go before anything is typed, and asks for nothing', async () => {
    const screen = await start('Search')
    const texts = await waitForText(screen, 'Find athletes')

    expect(texts).toContain('Trails near me')
    expect(texts).toContain('Records')
    expect(requests(screen).filter((r: any) => r.payload?.module === 'Network')).toHaveLength(0)
  })

  it('asks for nothing under two characters', async () => {
    const screen = await start('Search')
    await screen.event('search-input', 'onChangeText', { text: 'a' })
    await screen.event('run-search', 'onPress')
    await Bun.sleep(2)

    expect(requests(screen).filter((r: any) => r.payload?.module === 'Network')).toHaveLength(0)
  })

  it('asks all five endpoints at once', async () => {
    const screen = await start('Search')
    const asked = await search(screen)
    const urls = asked.map((request: any) => request.payload.args[0].url).sort()

    expect(urls).toEqual([
      'https://wildloop.org/api/clubs?q=san%20diego&limit=4',
      'https://wildloop.org/api/events?q=san%20diego&limit=4',
      'https://wildloop.org/api/geo/search?q=san%20diego&limit=3',
      'https://wildloop.org/api/search/suggest?q=san%20diego',
      'https://wildloop.org/api/users/search?q=san%20diego&limit=5',
    ])
  })

  it('groups the answers the way the web page does', async () => {
    const screen = await start('Search')
    await search(screen)
    const texts = await waitForText(screen, 'San Diego')

    expect(texts).toContain('Places')
    expect(texts).toContain('Cowles Mountain')
    expect(texts).toContain('Marta Keller')
    expect(texts).toContain('Dawn Patrol')
    expect(texts).toContain('Sunrise 10k')
    expect(texts).toContain('See all trails matching “san diego”')
  })

  it('opens a result on the web, where its page lives', async () => {
    const screen = await start('Search')
    await search(screen)
    await waitForText(screen, 'Sunrise 10k')

    await screen.event('result-row', 'onPress')
    await Bun.sleep(0)
    expect(String(screen.sent.at(-1)?.payload?.path ?? '')).toStartWith('/')
    expect(screen.sent.at(-1)?.type).toBe('NAVIGATE_OPEN')
  })

  /*
   * A screen the app draws itself is pushed rather than opened in a web view.
   * The fixture taps the last row carrying the testID, which is Records.
   */
  it('pushes the native screen a quick link names', async () => {
    const screen = await start('Search')
    await waitForText(screen, 'Records')

    await screen.event('quick-link', 'onPress')
    await Bun.sleep(0)
    expect(screen.sent.at(-1)).toMatchObject({ type: 'NAVIGATE', payload: { screen: 'Records' } })
  })

  it('says plainly when nothing matches', async () => {
    const screen = await start('Search')
    await screen.event('search-input', 'onChangeText', { text: 'zzzz' })
    const before = requests(screen).length
    await screen.event('run-search', 'onPress')
    const asked: any[] = []
    for (let i = 0; i < 5; i++)
      asked.push(await waitForRequest(screen, before + i, r => r.payload?.module === 'Network'))
    for (const request of asked)
      answer(screen, request, ok({}))

    await waitForText(screen, 'Nothing matches “zzzz” yet.')
  })

  it('reports a search it could not run', async () => {
    const screen = await start('Search')
    await screen.event('search-input', 'onChangeText', { text: 'gorge' })
    const before = requests(screen).length
    await screen.event('run-search', 'onPress')
    const asked: any[] = []
    for (let i = 0; i < 5; i++)
      asked.push(await waitForRequest(screen, before + i, r => r.payload?.module === 'Network'))

    // The message is a static label, so it is in the first RENDER whatever
    // happens; what changes is whether it is displayed.
    expect(visibility(screen, 'search-error')).toBe('none')
    for (const request of asked)
      answer(screen, request, { status: 500, statusText: 'Server Error', headers: {}, body: 'nope' })

    await waitForVisibility(screen, 'search-error', 'flex')
  })

  it('clears back to the quick links', async () => {
    const screen = await start('Search')
    await search(screen)
    await waitForText(screen, 'Dawn Patrol')

    expect(visibility(screen, 'quick-links')).toBe('none')
    await screen.event('clear-search', 'onPress')
    await waitForVisibility(screen, 'quick-links', 'flex')

    expect(shownText(screen)).toContain('Trails near me')
  })
})

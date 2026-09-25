/**
 * Where to look: a country, and a region inside it.
 *
 * The filter row offers the Country dropdown only past one country, and a
 * region outside the US is ISO 3166-2 — `DE-BY`, not `BY`. The API's old
 * two-letter pattern ignored those, so asking for Bayern quietly answered
 * with the whole catalog, which is the kind of failure a page cannot show.
 *
 * `scripts/start-recording-qa.ts` boots the app against its own SQLite file,
 * whose catalog covers California, Bayern, Nordrhein-Westfalen and Tirol.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

async function trails(query: string): Promise<any> {
  const response = await fetch(`${API}/trails${query}`)
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json()
}

const countriesIn = (payload: any) => [...new Set(payload.trails.map((t: any) => t.country))].sort()
const namesIn = (payload: any) => payload.trails.map((t: any) => t.name).sort()

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
}, READY_TIMEOUT_MS + 10_000)

describe.skipIf(!qa)('trail coverage', () => {
  it('knows which countries and regions the catalog covers', async () => {
    const response = await fetch(`${API}/trails/stats`)
    expect(response.status).toBe(200)
    const stats = await response.json()

    expect(stats.countries.map((c: any) => c.code).sort()).toEqual(['AT', 'DE', 'US'])
    // More than one country is what puts the Country dropdown in the filter
    // row at all.
    expect(stats.countries.length).toBeGreaterThan(1)

    const bayern = stats.states.find((s: any) => s.code === 'DE-BY')
    expect(bayern).toMatchObject({ name: 'Bayern', country: 'DE', count: 2 })
    // A region is named by its code where the catalog has no name for it.
    expect(stats.states.find((s: any) => s.code === 'CA')).toMatchObject({ name: 'CA', country: 'US' })
  })
})

describe.skipIf(!qa)('trail filters', () => {
  it('answers for the whole catalog when asked out loud', async () => {
    const everywhere = await trails('?country=all&limit=50')
    expect(countriesIn(everywhere)).toEqual(['AT', 'DE', 'US'])
    expect(everywhere.meta.country).toBeNull()
  })

  it('narrows to one country, and says which it answered for', async () => {
    const germany = await trails('?country=DE&limit=50')
    expect(countriesIn(germany)).toEqual(['DE'])
    expect(namesIn(germany)).toEqual(['Eifel Forest Way', 'Isarwinkel Ridge', 'Partnachklamm Loop'])
    expect(germany.meta.country).toBe('DE')

    const austria = await trails('?country=AT&limit=50')
    expect(namesIn(austria)).toEqual(['Nordkette Panorama Trail'])
  })

  // The one the two-letter pattern used to swallow: `?state=DE-BY` came back
  // as every trail in the catalog, with the Region chip lit.
  it('narrows to an ISO 3166-2 region, not the whole catalog', async () => {
    const bayern = await trails('?country=DE&state=DE-BY&limit=50')
    expect(namesIn(bayern)).toEqual(['Isarwinkel Ridge', 'Partnachklamm Loop'])

    const nrw = await trails('?country=DE&state=DE-NW&limit=50')
    expect(namesIn(nrw)).toEqual(['Eifel Forest Way'])

    const tirol = await trails('?country=AT&state=AT-7&limit=50')
    expect(namesIn(tirol)).toEqual(['Nordkette Panorama Trail'])
  })

  it('takes a region code however it was typed', async () => {
    expect(namesIn(await trails('?country=de&state=de-nw&limit=50'))).toEqual(['Eifel Forest Way'])
  })

  it('still narrows to a two-letter US state', async () => {
    const california = await trails('?country=US&state=CA&limit=50')
    expect(countriesIn(california)).toEqual(['US'])
    expect(california.trails.map((t: any) => t.name)).toContain('Torrey Pines Loop')
  })

  it('answers an empty list for a country the catalog does not cover', async () => {
    // Asked for explicitly, so widening it would be the page lying about the
    // chip the visitor is looking at.
    const none = await trails('?country=JP&limit=50')
    expect(none.trails).toEqual([])
  })
})

/**
 * A trail that arrived as several rows is listed once, and the rows it was
 * folded from still answer at their own URLs (#1002).
 *
 * The catalog is imported from OpenStreetMap, where a way is whatever a
 * mapper drew between two junctions, so one trail is often the park's record
 * plus a few short ways sharing its name. `scripts/start-recording-qa.ts`
 * seeds Craggy Gardens Trail that way near Asheville — the park's 1.6 miles
 * and two ways continuing it — plus a different trail of the same name in
 * Maine, and runs `trails:fold-fragments` over them, as the nightly job does.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, APP, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
const qa = process.env.RECORDING_QA === '1'

/** The Craggy Gardens parking area, on the Parkway. */
const HERE = 'lat=35.7000&lng=-82.3800'

async function trails(query: string): Promise<any> {
  const response = await fetch(`${API}/trails?${query}`)
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json()
}

const craggy = (payload: any): any[] => payload.trails.filter((t: any) => t.name === 'Craggy Gardens Trail')

/** The seeded rows, by source id, read through the API rather than assumed. */
const ids: Record<string, number> = {}

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
  // A text search everywhere lists what the catalog lists; the rows behind
  // it are found by asking for each one's page directly below.
  const listed = await trails('q=craggy%20gardens&country=all&limit=50')
  for (const trail of craggy(listed))
    ids[trail.source_id] = Number(trail.id)
  // The pieces are not listed, so they are found next to the park's record:
  // the ingest wrote them in order, and the API answers any id.
  for (let id = ids['qa/craggy-gardens'] + 1; id <= ids['qa/craggy-gardens'] + 3; id++) {
    const response = await fetch(`${API}/trails/${id}`)
    if (response.ok) {
      const { trail } = await response.json()
      if (trail?.name === 'Craggy Gardens Trail')
        ids[trail.source_id] = Number(trail.id)
    }
  }
}, READY_TIMEOUT_MS + 10_000)

describe.skipIf(!qa)('a trail folded from pieces', () => {
  it('found every seeded row', () => {
    expect(Object.keys(ids).sort()).toEqual([
      'qa/craggy-gardens',
      'qa/craggy-gardens-maine',
      'qa/craggy-gardens-way-north',
      'qa/craggy-gardens-way-south',
    ])
  })

  it('is listed once near it, under the park\'s record', async () => {
    const near = await trails(`${HERE}&limit=50`)

    expect(craggy(near).map(t => t.source_id)).toEqual(['qa/craggy-gardens'])
    expect(near.meta.total).toBe(1)
  })

  it('is listed once in the catalog order and in its count, whatever the sort', async () => {
    for (const sort of ['distance', 'longest', 'name']) {
      const page = await trails(`${HERE}&sort=${sort}&limit=50`)
      expect(craggy(page).map(t => t.source_id), sort).toEqual(['qa/craggy-gardens'])
      expect(page.meta.total, sort).toBe(1)
    }
  })

  it('is found once by search, beside the same name somewhere else', async () => {
    const found = await trails('q=craggy%20gardens&country=all&limit=50')

    // Maine shares the name and nothing else, so it stays a trail of its own.
    expect(craggy(found).map(t => t.source_id).sort()).toEqual(['qa/craggy-gardens', 'qa/craggy-gardens-maine'])
    expect(found.meta.total).toBe(2)
  })

  it('counts in the national catalog without its pieces', async () => {
    const all = await trails('country=all&limit=500')
    const listed = all.trails.map((t: any) => Number(t.id))

    expect(listed).toContain(ids['qa/craggy-gardens'])
    expect(listed).not.toContain(ids['qa/craggy-gardens-way-north'])
    expect(listed).not.toContain(ids['qa/craggy-gardens-way-south'])
    expect(all.meta.total).toBe(all.trails.length)

    const us = await trails('country=US&limit=500')
    expect(us.trails.map((t: any) => Number(t.id))).not.toContain(ids['qa/craggy-gardens-way-north'])
    expect(us.meta.total).toBe(us.trails.length)
  })

  /*
   * The park's record is 1.6 miles and the two ways continuing it 0.3 and
   * 0.2, so the trail listed is 2.1 miles long. Its own row and line stay
   * as they are, beside the whole (app/Support/wholeTrail.ts).
   */
  it('is listed at the length of the whole trail, pieces included', async () => {
    const [trail] = craggy(await trails(`${HERE}&limit=50`))

    expect(trail.distance).toBe(2.1)
    expect(trail.ownDistance).toBe(1.6)
    expect(trail.pieces).toBe(2)
  })

  it('is filtered and sorted by the length of the whole trail', async () => {
    // Longer than two miles only with its pieces, and so never under 1.8.
    const longEnough = await trails(`${HERE}&minDistance=2&limit=50`)
    expect(craggy(longEnough).map(t => t.source_id)).toEqual(['qa/craggy-gardens'])
    const shortEnough = await trails(`${HERE}&maxDistance=1.8&limit=50`)
    expect(craggy(shortEnough)).toEqual([])

    for (const sort of ['distance', 'longest']) {
      const page = await trails(`${HERE}&sort=${sort}&limit=50`)
      expect(craggy(page).map(t => t.distance), sort).toEqual([2.1])
    }
    // Without a location, through the totals table and the length indexes.
    const longest = await trails('country=US&sort=longest&limit=500')
    const lengths = longest.trails.map((t: any) => Number(t.distance))
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a))
    // The same name in Maine is a trail of its own, and listed at its own 0.5.
    expect(craggy(longest).map(t => [t.source_id, t.distance])).toEqual([['qa/craggy-gardens', 2.1], ['qa/craggy-gardens-maine', 0.5]])
  })

  it('is suggested once as somebody types', async () => {
    const response = await fetch(`${API}/search/suggest?q=craggy`)
    expect(response.status).toBe(200)
    const payload = await response.json()
    const hrefs = (payload.suggestions ?? payload.data ?? []).filter((s: any) => s.kind === 'trail').map((s: any) => s.href)

    expect(hrefs).toContain(`/trail/${ids['qa/craggy-gardens']}`)
    expect(hrefs).not.toContain(`/trail/${ids['qa/craggy-gardens-way-north']}`)
    expect(hrefs).not.toContain(`/trail/${ids['qa/craggy-gardens-way-south']}`)
  })

  it('leaves its pieces out of the sitemap', async () => {
    const response = await fetch(`${API}/sitemap-trails-1.xml`)
    expect(response.status).toBe(200)
    const xml = await response.text()

    expect(xml).toContain(`/trail/${ids['qa/craggy-gardens']}</loc>`)
    expect(xml).not.toContain(`/trail/${ids['qa/craggy-gardens-way-north']}</loc>`)
    expect(xml).not.toContain(`/trail/${ids['qa/craggy-gardens-way-south']}</loc>`)
  })
})

describe.skipIf(!qa)('the URL of a piece', () => {
  /*
   * Saved trails, activities, shared links and search engines all still
   * point at the pieces. Each answers with a permanent redirect to the trail,
   * so a crawler moves the URL's standing there instead of splitting it.
   */
  it('redirects permanently to the trail it is part of', async () => {
    for (const piece of ['qa/craggy-gardens-way-north', 'qa/craggy-gardens-way-south']) {
      const response = await fetch(`${APP}/trail/${ids[piece]}`, { redirect: 'manual' })
      expect(response.status, piece).toBe(301)
      expect(new URL(response.headers.get('location') ?? '', APP).pathname, piece).toBe(`/trail/${ids['qa/craggy-gardens']}`)
    }
  })

  it('lands on the trail\'s own page when followed', async () => {
    const response = await fetch(`${APP}/trail/${ids['qa/craggy-gardens-way-north']}`)
    expect(response.status).toBe(200)
    expect(new URL(response.url).pathname).toBe(`/trail/${ids['qa/craggy-gardens']}`)
    expect(await response.text()).toContain(`https://wildloop.org/trail/${ids['qa/craggy-gardens']}`)
  })

  it('leaves the trail itself, and the same name elsewhere, where they are', async () => {
    for (const own of ['qa/craggy-gardens', 'qa/craggy-gardens-maine']) {
      const response = await fetch(`${APP}/trail/${ids[own]}`, { redirect: 'manual' })
      expect(response.status, own).toBe(200)
    }
  })

  it('still answers in the API as itself, saying which trail it is part of', async () => {
    const response = await fetch(`${API}/trails/${ids['qa/craggy-gardens-way-north']}`)
    expect(response.status).toBe(200)
    const { trail } = await response.json()

    expect(trail.source_id).toBe('qa/craggy-gardens-way-north')
    expect(trail.partOf).toBe(ids['qa/craggy-gardens'])

    const whole = await (await fetch(`${API}/trails/${ids['qa/craggy-gardens']}`)).json()
    expect(whole.trail.partOf).toBeNull()
  })

  it('answers the trail with its whole length and the lines of its pieces', async () => {
    const { trail } = await (await fetch(`${API}/trails/${ids['qa/craggy-gardens']}`)).json()

    expect(trail.distance).toBe(2.1)
    expect(trail.ownDistance).toBe(1.6)
    expect(trail.pieces).toBe(2)
    // Its own line stays its own, for navigation and records; the pieces
    // come beside it, for the map.
    expect(JSON.parse(trail.geometry)[0]).toEqual([35.699, -82.38])
    expect(trail.pieceRoutes).toHaveLength(2)
    // Graded on the whole trail, which the fold worked out with its length;
    // 2.1 miles and no climb is as easy as the 1.6 of its own row.
    expect(trail.difficulty).toBe('easy')
    expect(trail.ownDifficulty).toBe('easy')
  })

  it('is filtered by the grade of the whole trail', async () => {
    expect(craggy(await trails(`${HERE}&difficulty=easy&limit=50`)).map(t => t.source_id)).toEqual(['qa/craggy-gardens'])
    expect(craggy(await trails(`${HERE}&difficulty=moderate&limit=50`))).toEqual([])
  })

  /*
   * A scraper reads the description the page is served with and never runs
   * its script, so that has to be the whole trail too, not the 1.6 miles of
   * the park's own row that the client used to correct after hydration.
   */
  it('is described as the whole trail in the page as served', async () => {
    const html = await (await fetch(`${APP}/trail/${ids['qa/craggy-gardens']}`)).text()
    const description = html.match(/<meta name="description" content="([^"]*)"/)?.[1] ?? ''

    // The fixture has no recorded climb, so its grade comes from length alone
    // and the description says so (f0b18420).
    expect(description).toContain('Easy (estimated) · 2.1 mi')
    expect(description).not.toContain('1.6 mi')
    expect(html.match(/<meta property="og:description" content="([^"]*)"/)?.[1]).toBe(description)
  })
})

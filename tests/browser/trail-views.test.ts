/**
 * Trail page views, counted once per visitor and fed to "most popular".
 *
 * The count is a number per trail per day, and nothing reads it back but
 * ranking — so this asks ranking. `scripts/start-recording-qa.ts` seeds two
 * trails around Bend that are alike in everything ranking reads but distance:
 * Tumalo is closer, so it leads "most popular" until people look at Shevlin.
 *
 * Tumalo then gets everything that must NOT count — the same visitor three
 * times, a crawler, a script, its HTML and its API read — and Shevlin two
 * real visitors. Shevlin leads only if Tumalo counted exactly once.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, APP, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
const qa = process.env.RECORDING_QA === '1'

/** Downtown Bend. Tumalo starts half a mile away, Shevlin three. */
const BEND = 'lat=44.0582&lng=-121.3153'

// Unique to this run, so a stack left up from an earlier run, which still
// remembers its visitors, sees these as people it has not met.
const run = crypto.randomUUID().slice(0, 8)
const browser = (who: string) => `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 qa-${who}-${run}`
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'

async function popular(): Promise<string[]> {
  const response = await fetch(`${API}/trails?${BEND}&sort=popular&limit=10`)
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()).trails.map((t: any) => t.name)
}

async function view(trailId: number, userAgent: string, headers: Record<string, string> = {}): Promise<any> {
  const response = await fetch(`${API}/trails/${trailId}/view`, {
    method: 'POST',
    headers: { 'User-Agent': userAgent, ...headers },
  })
  expect(response.status, await response.clone().text()).toBe(202)
  return await response.json()
}

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
}, READY_TIMEOUT_MS + 10_000)

describe.skipIf(!qa)('trail page views', () => {
  it('counts each visitor once, and nothing a bot or a page load does', async () => {
    const before = await popular()
    expect(before.slice(0, 2)).toEqual(['Tumalo Creek Trail', 'Shevlin Creek Trail'])

    const ids = await (await fetch(`${API}/trails?${BEND}&limit=10`)).json()
    const id = (name: string) => Number(ids.trails.find((t: any) => t.name === name).id)
    const tumalo = id('Tumalo Creek Trail')
    const shevlin = id('Shevlin Creek Trail')

    // One person, three looks: the first counts, the rest are the same view.
    expect(await view(tumalo, browser('hiker'))).toEqual({ success: true, counted: true })
    expect(await view(tumalo, browser('hiker'))).toEqual({ success: true, counted: false, reason: 'repeat' })
    expect(await view(tumalo, browser('hiker'))).toEqual({ success: true, counted: false, reason: 'repeat' })

    // A crawler as often as it likes, and a script that does not pretend.
    for (let i = 0; i < 4; i++)
      expect(await view(tumalo, GOOGLEBOT)).toEqual({ success: true, counted: false, reason: 'bot' })
    expect(await view(tumalo, 'curl/8.7.1')).toEqual({ success: true, counted: false, reason: 'bot' })
    // A prerendered page that nobody has looked at yet, and another site.
    expect(await view(tumalo, browser('prerender'), { 'Sec-Purpose': 'prefetch;prerender' })).toMatchObject({ counted: false, reason: 'prefetch' })
    expect(await view(tumalo, browser('elsewhere'), { 'Sec-Fetch-Site': 'cross-site' })).toMatchObject({ counted: false, reason: 'cross-site' })

    // Serving the page and the trail is not a view: crawlers, previews and
    // prefetches ask for both, and a visit from a list never asks the API.
    for (let i = 0; i < 3; i++) {
      expect((await fetch(`${APP}/trail/${tumalo}`, { headers: { 'User-Agent': browser('reader') } })).status).toBe(200)
      expect((await fetch(`${API}/trails/${tumalo}`, { headers: { 'User-Agent': browser('reader') } })).status).toBe(200)
    }

    // Two people look at Shevlin.
    expect(await view(shevlin, browser('first'))).toEqual({ success: true, counted: true })
    expect(await view(shevlin, browser('second'))).toEqual({ success: true, counted: true })

    // Tumalo has one view and Shevlin two, so Shevlin leads. Any of the above
    // counting would have given Tumalo at least as many. The writes land
    // after the responses, so give them a moment.
    let after: string[] = []
    for (let attempt = 0; attempt < 20; attempt++) {
      after = await popular()
      if (after[0] === 'Shevlin Creek Trail')
        break
      await Bun.sleep(100)
    }
    expect(after.slice(0, 2)).toEqual(['Shevlin Creek Trail', 'Tumalo Creek Trail'])
  })

  it('refuses an id that is not a trail id, and counts nothing for one that names no trail', async () => {
    const bad = await fetch(`${API}/trails/nope/view`, { method: 'POST', headers: { 'User-Agent': browser('typo') } })
    expect(bad.status).toBe(422)
    // Answered like any other view; the write finds no trail and adds nothing.
    expect(await view(987_654_321, browser('ghost'))).toEqual({ success: true, counted: true })
  })
})

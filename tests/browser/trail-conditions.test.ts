/**
 * The condition warning a trail page puts at the top, against a real server
 * and a throwaway database.
 *
 * Three things this proves that a pure test cannot: that the report time
 * survives a write and an edit, that a visit date is checked before it is
 * stored, and that the warning is settled over every review of the trail
 * rather than the page of reviews the Reviews tab happened to ask for.
 *
 * `scripts/start-recording-qa.ts` boots the app against its own SQLite file,
 * never the developer's.
 */
import { beforeAll, describe, expect, it } from 'bun:test'
import { API, csrfToken, READY_TIMEOUT_MS, startQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

const ORIGIN = 'http://127.0.0.1:4320'
const DAY_MS = 86_400_000
const day = (agoInDays: number) => new Date(Date.now() - agoInDays * DAY_MS).toISOString().slice(0, 10)

let trailId = 0
/** An athlete each, because there is one review per person per trail. */
const bearers: string[] = []

/**
 * This run's mark, written into every review it posts.
 *
 * The servers are reused when they are already up, so the trail can still be
 * carrying reports from an earlier run. Every assertion here is about the
 * reports this run wrote, found by their note, rather than about whatever
 * else the trail happens to hold.
 */
const marker = crypto.randomUUID().slice(0, 8)
const ours = (report: any) => String(report?.note ?? '').includes(marker)
const oursIn = (summary: any) => summary.reports.filter(ours)

/** Register an athlete and keep their bearer token. */
async function register(): Promise<string> {
  const token = await csrfToken(API)
  const response = await fetch(`${API}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': ORIGIN,
      'X-CSRF-Token': token,
      'Cookie': `X-CSRF-Token=${encodeURIComponent(token)}`,
    },
    body: JSON.stringify({
      name: 'Conditions QA',
      email: `conditions-${crypto.randomUUID()}@example.test`,
      password: `Local-QA-${crypto.randomUUID()}`,
    }),
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()).token
}

/** Write (or rewrite) one athlete's review of the trail. */
async function review(bearer: string, body: Record<string, unknown>): Promise<Response> {
  const payload = { rating: 4, content: 'Walked the whole loop this morning.', ...body }
  return await fetch(`${API}/trails/${trailId}/reviews`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    // Every review this run writes carries its mark, whatever it says.
    body: JSON.stringify({ ...payload, content: `${payload.content} [${marker}]` }),
  })
}

/** The trail's reviews, and the conditions the server settled for them. */
async function conditions(query = ''): Promise<any> {
  // `cache: 'reload'` because the answer is kept 15 minutes, here and in the
  // browser, and this test writes between reads.
  const response = await fetch(`${API}/trails/${trailId}/reviews${query}`, { cache: 'reload' })
  expect(response.status, await response.clone().text()).toBe(200)
  return await response.json()
}

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
  const listed = await fetch(`${API}/trails?country=all&limit=50`)
  expect(listed.status).toBe(200)
  // A trail of its own, so a warning raised here cannot show up in another
  // suite's catalog assertions.
  trailId = (await listed.json()).trails.find((row: any) => row.name === 'Condition Report Loop').id
  expect(trailId).toBeGreaterThan(0)
  bearers.push(await register(), await register())
}, READY_TIMEOUT_MS + 30_000)

describe.skipIf(!qa)('trail conditions', () => {
  it('refuses a visit date that is malformed or in the future', async () => {
    for (const visit_date of ['yesterday', '2026-02-31', '2026-9-4', new Date(Date.now() + 40 * DAY_MS).toISOString().slice(0, 10)]) {
      const refused = await review(bearers[0], { conditions: 'flooded', visit_date })
      expect(refused.status, visit_date).toBe(422)
      expect((await refused.json()).fields.visit_date, visit_date).toContain('YYYY-MM-DD')
    }
  })

  // The regression. One review per person per trail, so somebody who walked
  // this trail last month edits that review to warn about today's flooding.
  // The report is new even though the review is not.
  it('raises today\'s warning from a review written earlier', async () => {
    const written = await review(bearers[0], { conditions: 'closed', visit_date: day(40) })
    expect(written.status, await written.clone().text()).toBe(201)
    const created = (await written.json()).review

    const before = await conditions()
    expect(oursIn(before.conditions).map((r: any) => [r.id, r.at])).toEqual([['closed', day(40)]])
    // A month old: on the conditions list, not on the page as a warning.
    expect(before.conditions.danger && ours(before.conditions.danger)).toBeFalsy()
    const writtenAt = before.reviews.find((r: any) => r.id === created.id).createdAt
    expect(before.reviews.find((r: any) => r.id === created.id).conditionsReportedAt).toBe(day(40))

    const edited = await review(bearers[0], { conditions: 'flooded', content: 'The creek crossing is waist deep today.' })
    expect(edited.status, await edited.clone().text()).toBe(200)

    const after = await conditions()
    expect(after.conditions.danger?.id).toBe('flooded')
    expect(after.conditions.danger?.note).toContain('waist deep')
    expect(ours(after.conditions.danger)).toBe(true)

    // The distinction the warning rests on: the review was written when it
    // was written, and the condition on it was seen today.
    const row = after.reviews.find((r: any) => r.id === created.id)
    expect(row.createdAt).toBe(writtenAt)
    expect(Date.parse(row.conditionsReportedAt)).toBeGreaterThan(Date.parse(`${day(1)}T00:00:00Z`))
  })

  it('does not let a pleasant path report certify that a closure was lifted', async () => {
    expect((await review(bearers[0], { conditions: 'closed' })).status).toBe(200)
    expect((await review(bearers[1], { conditions: 'excellent', content: 'Lovely dry singletrack all the way round.' })).status).toBe(201)

    const { conditions: summary } = await conditions()
    // Newest first, and the newest word on this trail is that it is lovely.
    expect(summary.reports[0].id).toBe('excellent')
    expect(oursIn(summary).map((r: any) => r.id)).toEqual(['excellent', 'closed'])
    expect(summary.danger?.id).toBe('closed')
    expect(ours(summary.danger)).toBe(true)
  })

  it('settles the warning over every review, not the page the tab asked for', async () => {
    const page = await conditions('?limit=1')
    expect(page.reviews).toHaveLength(1)
    expect(page.meta.total).toBeGreaterThan(1)
    // The closure is on a review this page left out.
    expect(page.reviews[0].conditions).not.toBe('closed')
    expect(oursIn(page.conditions).map((r: any) => r.id)).toEqual(['excellent', 'closed'])
    expect(page.conditions.danger?.id).toBe('closed')
    expect(ours(page.conditions.danger)).toBe(true)
  })

  it('dates a report from the visit, and forgets it when the condition goes', async () => {
    expect((await review(bearers[0], { conditions: 'icy', visit_date: day(2) })).status).toBe(200)

    const dated = await conditions()
    expect(oursIn(dated.conditions).map((r: any) => [r.id, r.at]))
      .toEqual([['excellent', expect.any(String)], ['icy', day(2)]])
    // Ice is ground the newer report has walked on, so that one does clear it
    // — which the closure it replaced would not have been.
    expect(dated.conditions.danger && ours(dated.conditions.danger)).toBeFalsy()

    expect((await review(bearers[0], { conditions: null })).status).toBe(200)
    const gone = await conditions()
    expect(oursIn(gone.conditions).map((r: any) => r.id)).toEqual(['excellent'])
  })
})

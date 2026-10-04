import { expect, test } from '@playwright/test'
import { QA_PORTS } from './qa-ports'

/**
 * Opening a trail from its card, without a page load in between.
 *
 * The trail page fetches the trail when the store doesn't have it and upserts
 * it. The upsert pushed onto the store's list in place, which no signal saw,
 * so a trail reached by client-side navigation rendered "Trail not found"
 * until something reassigned the whole list. A full page load hid it: the
 * featured-trails bootstrap reassigned the list a moment later.
 *
 * The QA stack (scripts/start-recording-qa.ts) has one trail, Torrey Pines
 * Loop, so it is always among the featured 200 and already in the store. On
 * the real catalog, a trail found by searching near a town almost never is,
 * so the featured list is emptied here to put the page on that path.
 */

const origin = `http://127.0.0.1:${QA_PORTS.proxy}`

test('a trail opened from its card renders, even when the store has not loaded it', async ({ page }) => {
  await page.route('**/api/trails?limit=200&sort=featured', route => route.fulfill({ json: { success: true, trails: [] } }))
  const featured = page.waitForResponse(r => r.url().includes('/api/trails?limit=200&sort=featured'))

  await page.goto(`${origin}/trails?near=San%20Diego&lat=32.71571&lng=-117.16472`)
  await featured
  const card = page.getByRole('link', { name: /Torrey Pines Loop/ }).first()
  await expect(card).toBeVisible()

  const fetched = page.waitForResponse(r => /\/api\/trails\/\d+$/.test(new URL(r.url()).pathname))
  await card.click()
  expect((await fetched).ok()).toBeTruthy()

  await expect(page).toHaveURL(/\/trail\/\d+$/)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Torrey Pines Loop')
  await expect(page.getByText('Trail not found')).toHaveCount(0)
})

/**
 * The trail a URL names, and no stand-in for it.
 *
 * The store used to be seeded with twelve demo trails under ids 1-12, which are
 * real ids in the catalog. `findTrail(1)` answered with the fixture, and because
 * the page skips its fetch when the store already holds the id, `/api/trails/1`
 * was never requested — so the page rendered a fabricated trail under a URL for
 * a different one, permanently. It only became visible once the heading was
 * server-rendered: the document said "Torrey Pines Loop" in its `h1` and painted
 * "Eagle Peak Summit" beneath it.
 *
 * The fixtures are gone and the store is filled only from the API, so this now
 * guards against their return — in any form that would let something other than
 * the API answer for an id. Both halves are asserted because they fail
 * independently: the request has to happen at all, and no fabricated name may
 * appear on the page.
 */
test('a trail page renders the record the API holds for its id', async ({ page }) => {
  const fetched = page.waitForResponse(r => new URL(r.url()).pathname === '/api/trails/1')

  await page.goto(`${origin}/trail/1`)

  // This timed out while the store was seeded: it already had a trail under id
  // 1, so the page never asked for the real one.
  const payload = await fetched.then(r => r.json())
  const name = String(payload?.trail?.name ?? '').trim()
  expect(name, 'the API must name trail 1 for this to compare against').not.toBe('')

  await expect(page.getByText('Eagle Peak Summit')).toHaveCount(0)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(name)
})

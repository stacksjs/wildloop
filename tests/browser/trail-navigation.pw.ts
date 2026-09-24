import { expect, test } from '@playwright/test'

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

const origin = 'http://127.0.0.1:4322'

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

import { expect, test, type Page } from '@playwright/test'

/**
 * Conditions people report on a trail — the weather and hazards as well as
 * the path — listed on its page, and a danger reported this week put at the
 * top in red.
 *
 * Runs against the isolated QA stack (scripts/start-recording-qa.ts), whose
 * catalog has Torrey Pines Loop.
 */

const origin = 'http://127.0.0.1:4322'

async function signUp(page: Page) {
  const password = `Local-QA-${crypto.randomUUID()}`
  await page.goto(`${origin}/register`)
  const form = page.locator('form').filter({ has: page.locator('#name') })
  await form.getByLabel('Full Name', { exact: true }).fill('Conditions QA')
  await form.getByLabel('Email', { exact: true }).fill(`conditions-${crypto.randomUUID()}@example.test`)
  await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByLabel('Confirm Password', { exact: true }).fill(password)
  await page.locator('#terms').check()
  const registered = page.waitForResponse(r => r.url().endsWith('/api/register') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create Account', exact: true }).click()
  expect((await registered).ok()).toBeTruthy()
  await expect(page).not.toHaveURL(/\/register/)
}

test('a flooding report is listed and shown at the top of the trail in red', async ({ page }) => {
  await signUp(page)
  await page.goto(`${origin}/trails`)
  await page.getByRole('link', { name: /Torrey Pines Loop/ }).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Torrey Pines Loop')
  const trailId = Number(new URL(page.url()).pathname.split('/').pop())

  // Reported through the form, the way anyone would. The reviews are cached
  // for 15 minutes in the browser and on the server, and posting has to get
  // past both: the report shows at once, and so does the alert.
  await page.getByRole('button', { name: /Conditions/ }).first().click()
  await page.getByRole('button', { name: 'Report conditions' }).click()
  await page.getByRole('button', { name: 'Rate 3 stars' }).click()
  await page.locator('#review-tips').fill('The creek crossing is waist deep after the storm.')
  await page.getByRole('button', { name: 'Flooded', exact: true }).click()
  const posted = page.waitForResponse(r => r.url().endsWith(`/api/trails/${trailId}/reviews`) && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  expect((await posted).ok()).toBeTruthy()

  const alert = page.getByRole('alert').filter({ hasText: 'Flooded reported on this trail' })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('waist deep')

  await alert.getByRole('link', { name: /See all condition reports/ }).click()
  await expect(page.getByRole('button', { name: /Conditions \(1\)/ })).toBeVisible()
  await expect(page.getByText('Danger', { exact: true })).toBeVisible()
  await expect(page.getByText('The creek crossing is waist deep after the storm.').first()).toBeVisible()
})

test('editing an old review raises today\'s warning', async ({ page }) => {
  // One review per person per trail, so somebody who walked this trail
  // before comes back and edits the review they already have. The row is as
  // old as it was; the hazard on it is not.
  await signUp(page)
  await page.goto(`${origin}/trails`)
  await page.getByRole('link', { name: /Torrey Pines Loop/ }).first().click()
  // Wait for the page itself: reading the URL before the navigation lands
  // gives the trail id of the list, which is no id at all.
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Torrey Pines Loop')
  const trailId = Number(new URL(page.url()).pathname.split('/').pop())
  expect(trailId).toBeGreaterThan(0)

  await page.getByRole('button', { name: /Conditions/ }).first().click()
  await page.getByRole('button', { name: 'Report conditions' }).click()
  await page.getByRole('button', { name: 'Rate 4 stars' }).click()
  await page.locator('#review-tips').fill('Dry and clear the whole way round today.')
  await page.getByRole('button', { name: 'Good', exact: true }).click()
  const first = page.waitForResponse(r => r.url().endsWith(`/api/trails/${trailId}/reviews`) && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  expect((await first).ok()).toBeTruthy()

  // Back later, with something worth warning about.
  await page.getByRole('button', { name: 'Report conditions' }).click()
  await page.locator('#review-tips').fill('The gate is locked, the trail is closed.')
  await page.getByRole('button', { name: 'Closed', exact: true }).click()
  const edited = page.waitForResponse(r => r.url().endsWith(`/api/trails/${trailId}/reviews`) && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Submit', exact: true }).click()
  expect((await edited).ok()).toBeTruthy()

  const alert = page.getByRole('alert').filter({ hasText: 'Closed reported on this trail' })
  await expect(alert).toBeVisible()
  await expect(alert).toContainText('gate is locked')

  // And it survives the reload, because the server settled it too.
  await page.reload()
  await expect(page.getByRole('alert').filter({ hasText: 'Closed reported on this trail' })).toBeVisible()
})

test('the review form offers weather and hazards', async ({ page }) => {
  await signUp(page)
  await page.goto(`${origin}/trails`)
  await page.getByRole('link', { name: /Torrey Pines Loop/ }).first().click()
  await page.getByRole('button', { name: /Conditions/ }).first().click()
  await page.getByRole('button', { name: 'Report conditions' }).click()
  for (const label of ['Snow', 'Icy', 'Flooded', 'Washed out', 'Extreme heat', 'Wildfire or smoke', 'Closed'])
    await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible()
})

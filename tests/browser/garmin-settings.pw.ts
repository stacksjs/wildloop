import { expect, test, type Page } from '@playwright/test'

/**
 * The Garmin card on Settings shows exactly one state, and the one the server
 * reported.
 *
 * Reached by client-side navigation (Profile's gear, the Menu, the account
 * menu), the card said "Not available yet" and "Connected · Waiting for your
 * first activity" at once, while /api/garmin/status answered
 * `{ configured: false, connected: false }`. On navigation stx merges every
 * layout component's scope into the page's, and the offline banner's
 * `connected` (true while online) replaced the page's own. A full page load
 * never showed it, which is why these tests arrive by clicking a link.
 *
 * Runs against the isolated QA stack (scripts/start-recording-qa.ts), where
 * Garmin has no credentials, so the real answer is "unavailable". The other
 * states are the status endpoint answering as it would once Garmin approves.
 */

const origin = 'http://127.0.0.1:4322'

async function signUp(page: Page) {
  const password = `Local-QA-${crypto.randomUUID()}`
  await page.goto(`${origin}/register`)
  const form = page.locator('form').filter({ has: page.locator('#name') })
  await form.getByLabel('Full Name', { exact: true }).fill('Garmin QA')
  await form.getByLabel('Email', { exact: true }).fill(`garmin-${crypto.randomUUID()}@example.test`)
  await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByLabel('Confirm Password', { exact: true }).fill(password)
  await page.locator('#terms').check()
  const registered = page.waitForResponse(r => r.url().endsWith('/api/register') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create Account', exact: true }).click()
  expect((await registered).ok()).toBeTruthy()
  await expect(page).not.toHaveURL(/\/register/)
}

/** Arrive at Settings the way people do: a client-side link from another page. */
async function openSettingsFrom(page: Page, from: string) {
  await page.goto(`${origin}${from}`)
  const status = page.waitForResponse(r => r.url().endsWith('/api/garmin/status'))
  // Clicked in the page rather than by pointer: the QA stack's recording
  // controls overlay the mobile viewport's links.
  await page.locator('a[href="/settings"]').first().evaluate(link => (link as HTMLElement).click())
  await expect(page).toHaveURL(/\/settings$/)
  await status
}

function garminCard(page: Page) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: 'Garmin', exact: true }) })
}

/** The router cross-fades pages; a screenshot mid-fade shows both. */
async function settled(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))))
}

function answerStatus(page: Page, body: Record<string, unknown>) {
  return page.route('**/api/garmin/status', route => route.fulfill({ json: { success: true, ...body } }))
}

test('before Garmin approves the app, the card never claims a connection', async ({ page }, testInfo) => {
  await signUp(page)

  for (const from of ['/profile', '/menu', '/feed']) {
    await openSettingsFrom(page, from)
    const card = garminCard(page)
    await expect(card.getByText('Awaiting Garmin approval')).toBeVisible()
    await expect(card.getByText(/Connected/)).toHaveCount(0)
    await expect(card.getByText(/Waiting for your first activity/)).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Disconnect' })).toHaveCount(0)
    await expect(card.getByRole('button', { name: 'Connect Garmin' })).toHaveCount(0)
    await settled(page)
    await card.screenshot({ path: testInfo.outputPath(`unavailable-from-${from.slice(1)}.png`) })
  }

  // And on a full page load.
  await page.goto(`${origin}/settings`)
  await expect(garminCard(page).getByText('Awaiting Garmin approval')).toBeVisible()
  await expect(garminCard(page).getByText(/Connected/)).toHaveCount(0)
})

test('once approved but not linked, it offers to connect and says nothing is connected', async ({ page }) => {
  await signUp(page)
  await answerStatus(page, { configured: true, connected: false, connectedAt: null, lastSyncAt: null, importedCount: 0 })

  await openSettingsFrom(page, '/profile')
  const card = garminCard(page)
  await expect(card.getByRole('button', { name: 'Connect Garmin' })).toBeVisible()
  await expect(card.getByText(/Connected/)).toHaveCount(0)
  await expect(card.getByText('Awaiting Garmin approval')).toHaveCount(0)
})

test('connected with nothing imported says so about Garmin, not the account', async ({ page }, testInfo) => {
  await signUp(page)
  await answerStatus(page, { configured: true, connected: true, connectedAt: '2026-09-20T09:00:00Z', lastSyncAt: null, importedCount: 0 })

  await openSettingsFrom(page, '/menu')
  const card = garminCard(page)
  await expect(card.getByText(/^Connected since /)).toBeVisible()
  await expect(card.getByText('No Garmin activities imported yet')).toBeVisible()
  await expect(card.getByText(/Waiting for your first activity/)).toHaveCount(0)
  await expect(card.getByText('Awaiting Garmin approval')).toHaveCount(0)
  await settled(page)
  await card.screenshot({ path: testInfo.outputPath('connected-empty.png') })
})

test('connected with imports counts them and dates the latest', async ({ page }) => {
  await signUp(page)
  await answerStatus(page, { configured: true, connected: true, connectedAt: '2026-09-20T09:00:00Z', lastSyncAt: '2026-09-22T18:30:00Z', importedCount: 3 })

  await openSettingsFrom(page, '/profile')
  await expect(garminCard(page).getByText(/^3 Garmin activities imported · last on /)).toBeVisible()
})

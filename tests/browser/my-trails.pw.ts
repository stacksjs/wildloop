import { expect, test, type Page } from '@playwright/test'

/**
 * Your trails: the ones you saved and the ones you have done, on the Trails
 * page and from the Account menu.
 *
 * The saved list used to be filtered out of the trails this device had
 * cached, so a trail saved elsewhere was missing and the profile said "No
 * saved trails" with three saved. The cache is emptied here before looking,
 * which is the case that hid them.
 *
 * Runs against the isolated QA stack (scripts/start-recording-qa.ts): a fresh
 * database whose one trail is Torrey Pines Loop.
 */

const origin = 'http://127.0.0.1:4322'
const STORE_KEY = 'wildloop-v5'

async function signUp(page: Page) {
  const password = `Local-QA-${crypto.randomUUID()}`
  await page.goto(`${origin}/register`)
  const form = page.locator('form').filter({ has: page.locator('#name') })
  await form.getByLabel('Full Name', { exact: true }).fill('Lists QA')
  await form.getByLabel('Email', { exact: true }).fill(`lists-${crypto.randomUUID()}@example.test`)
  await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByLabel('Confirm Password', { exact: true }).fill(password)
  await page.locator('#terms').check()
  const registered = page.waitForResponse(r => r.url().endsWith('/api/register') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create Account', exact: true }).click()
  expect((await registered).ok()).toBeTruthy()
  await expect(page).not.toHaveURL(/\/register/)
}

/** Forget the trails this device cached, keeping the session. */
async function forgetCachedTrails(page: Page) {
  await page.evaluate((key) => {
    try {
      const raw = localStorage.getItem(key)
      if (!raw)
        return
      const store = JSON.parse(raw)
      store.trails = []
      store.savedTrailIds = []
      localStorage.setItem(key, JSON.stringify(store))
    }
    catch {}
  }, STORE_KEY)
}

test('saved and completed trails are listed from the server, and reachable from the Account menu', async ({ page }) => {
  await signUp(page)

  // Save Torrey Pines from its page.
  await page.goto(`${origin}/trails`)
  await page.getByRole('link', { name: /Torrey Pines Loop/ }).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Torrey Pines Loop')
  const trailId = Number(new URL(page.url()).pathname.split('/').pop())
  const saved = page.waitForResponse(r => r.url().endsWith(`/api/trails/${trailId}/save`) && r.request().method() === 'PUT')
  await page.getByRole('button', { name: /^Save/ }).first().click()
  expect((await saved).ok()).toBeTruthy()

  // And do it: a manual activity on the trail.
  const recorded = await page.evaluate(async (id) => {
    const token = localStorage.getItem('auth_token') ?? ''
    const res = await fetch('/api/activities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ trail_id: id, activity_type: 'Hike', distance: 2.4, duration: '48:00', completed_at: '2026-09-09T16:00:00Z' }),
    })
    return res.status
  }, trailId)
  expect(recorded).toBeLessThan(300)

  await forgetCachedTrails(page)

  // Saved, from the Trails page.
  await page.goto(`${origin}/trails?list=saved`)
  const savedTab = page.getByRole('tab', { name: /Saved/ })
  await expect(savedTab).toHaveAttribute('aria-selected', 'true')
  await expect(savedTab).toContainText('1')
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Saved trails')
  await expect(page.getByRole('link', { name: /Torrey Pines Loop/ }).first()).toBeVisible()

  // Completed, one tap away.
  await page.getByRole('tab', { name: /Completed/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Completed trails')
  await expect(page.getByText('Done Sep 9, 2026')).toBeVisible()

  // The profile's Saved tab too, from an empty cache.
  await forgetCachedTrails(page)
  await page.goto(`${origin}/profile?tab=saved`)
  await expect(page.getByRole('link', { name: /Torrey Pines Loop/ })).toBeVisible()
  await expect(page.getByText('No saved trails')).toHaveCount(0)

  // Unsaving from the list takes it away.
  await page.goto(`${origin}/trails?list=saved`)
  const unsaved = page.waitForResponse(r => r.url().endsWith(`/api/trails/${trailId}/save`) && r.request().method() === 'DELETE')
  await page.getByRole('button', { name: 'Remove Torrey Pines Loop from saved trails' }).click()
  expect((await unsaved).ok()).toBeTruthy()
  await expect(page.getByText('No saved trails yet')).toBeVisible()
})

test('the Account menu opens both lists', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 })
  await signUp(page)
  await page.goto(`${origin}/`)

  await page.getByRole('button', { name: 'Account' }).click()
  await page.getByRole('menuitem', { name: 'Saved trails' }).click()
  await expect(page).toHaveURL(/\/trails\?list=saved/)
  await expect(page.getByRole('tab', { name: /Saved/ })).toHaveAttribute('aria-selected', 'true')

  await page.getByRole('button', { name: 'Account' }).click()
  await page.getByRole('menuitem', { name: 'Completed trails' }).click()
  await expect(page).toHaveURL(/\/trails\?list=completed/)
  await expect(page.getByText('No completed trails yet')).toBeVisible()
})

test('mark a trail as done from its page, without saving it, and take it back', async ({ page }) => {
  await signUp(page)
  await page.goto(`${origin}/trails`)
  await page.getByRole('link', { name: /Torrey Pines Loop/ }).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Torrey Pines Loop')
  const trailId = Number(new URL(page.url()).pathname.split('/').pop())

  const marked = page.waitForResponse(r => r.url().endsWith(`/api/trails/${trailId}/done`) && r.request().method() === 'PUT')
  await page.getByRole('button', { name: 'Mark this trail as done' }).click()
  expect((await marked).ok()).toBeTruthy()
  await expect(page.getByText('You have done this trail')).toBeVisible()

  // Done is not saved: the heart stays off and the Saved list stays empty.
  await expect(page.getByRole('button', { name: 'Save this trail' }).first()).toBeVisible()
  await page.goto(`${origin}/trails?list=completed`)
  await expect(page.getByText('Marked as done', { exact: true })).toBeVisible()
  await page.getByRole('tab', { name: /Saved/ }).click()
  await expect(page.getByText('No saved trails yet')).toBeVisible()

  // Saved and done, then unsaved: still done.
  await page.goto(`${origin}/trail/${trailId}`)
  const saved = page.waitForResponse(r => r.url().endsWith(`/api/trails/${trailId}/save`) && r.request().method() === 'PUT')
  await page.getByRole('button', { name: 'Save this trail' }).first().click()
  expect((await saved).ok()).toBeTruthy()
  const unsaved = page.waitForResponse(r => r.url().endsWith(`/api/trails/${trailId}/save`) && r.request().method() === 'DELETE')
  await page.getByRole('button', { name: 'Remove from saved trails' }).first().click()
  expect((await unsaved).ok()).toBeTruthy()
  await page.goto(`${origin}/trails?list=completed`)
  await expect(page.getByText('Marked as done', { exact: true })).toBeVisible()

  // And taken back.
  await page.goto(`${origin}/trail/${trailId}`)
  const undone = page.waitForResponse(r => r.url().endsWith(`/api/trails/${trailId}/done`) && r.request().method() === 'DELETE')
  await page.getByRole('button', { name: 'Undo marking this trail as done' }).click()
  expect((await undone).ok()).toBeTruthy()
  await page.goto(`${origin}/trails?list=completed`)
  await expect(page.getByText('No completed trails yet')).toBeVisible()
})

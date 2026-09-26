import { expect, test, type Page } from '@playwright/test'

/**
 * The feed, laid out the way a trail app's feed is: you on the left, the
 * posts in the middle, people and trails worth a look on the right. A post
 * reads as a sentence and links the trail it was on.
 *
 * Runs against the isolated QA stack (scripts/start-recording-qa.ts). The
 * test logs its own activity on a seeded trail so there is a post to read.
 */

const origin = 'http://127.0.0.1:4322'

async function signUp(page: Page, name: string) {
  const password = `Local-QA-${crypto.randomUUID()}`
  await page.goto(`${origin}/register`)
  const form = page.locator('form').filter({ has: page.locator('#name') })
  await form.getByLabel('Full Name', { exact: true }).fill(name)
  await form.getByLabel('Email', { exact: true }).fill(`feed-${crypto.randomUUID()}@example.test`)
  await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByLabel('Confirm Password', { exact: true }).fill(password)
  await page.locator('#terms').check()
  const registered = page.waitForResponse(r => r.url().endsWith('/api/register') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create Account', exact: true }).click()
  expect((await registered).ok()).toBeTruthy()
  await expect(page).not.toHaveURL(/\/register/)
}

test('the feed has you, the posts as sentences with their trail, and suggestions', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  const name = `Feed QA ${crypto.randomUUID().slice(0, 6)}`
  await signUp(page, name)

  // A hike on Torrey Pines, logged through the API the way the form does.
  const trailId = await page.evaluate(async () => {
    const res = await fetch('/api/trails?country=all&limit=50')
    const body = await res.json()
    return body.trails.find((row: { name: string }) => row.name === 'Torrey Pines Loop').id as number
  })
  const status = await page.evaluate(async (id) => {
    const token = localStorage.getItem('auth_token') ?? ''
    const res = await fetch('/api/activities', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ trail_id: id, activity_type: 'Hike', distance: 2.4, duration: '48:00', elevation: 300, notes: 'Bluffs at low tide.', completed_at: new Date().toISOString() }),
    })
    return res.status
  }, trailId)
  expect(status).toBeLessThan(300)

  await page.goto(`${origin}/feed`)

  // You, on the left.
  const you = page.locator('aside').first()
  await expect(you.getByRole('link', { name })).toBeVisible()
  await expect(you.getByRole('link', { name: 'Your profile' })).toBeVisible()

  // The post: who did what where, and a card for the trail.
  const post = page.locator('article').filter({ hasText: 'Bluffs at low tide.' })
  await expect(post).toContainText(`${name} hiked Torrey Pines Loop`)
  await expect(post.getByText('Elev. gain')).toBeVisible()
  await expect(post.getByRole('link', { name: /Torrey Pines Loop.*San Diego/ })).toHaveAttribute('href', `/trail/${trailId}`)
  await expect(post.getByRole('button', { name: 'Share' })).toBeVisible()

  // Trails to look at, on the right.
  await expect(page.getByRole('heading', { name: /Trails (near|to explore)/ })).toBeVisible()

  await page.screenshot({ path: testInfo.outputPath('feed.png') })
})

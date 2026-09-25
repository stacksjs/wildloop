import { expect, test, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A profile photo chosen in Settings shows up in the header straight away,
 * survives a reload, and can be taken away again.
 *
 * Runs against the isolated QA stack (scripts/start-recording-qa.ts), whose
 * photo store is a temp folder, so the upload goes through the real pipeline:
 * POST /api/me/avatar re-encodes and crops it, and GET /api/avatars/... serves
 * it back only while it is the account's current photo.
 */

const origin = 'http://127.0.0.1:4322'
const photo = readFileSync(join(import.meta.dirname, '..', '..', 'public', 'images', 'marketing', 'wildloop-ridge-runner.jpg'))

// Desktop, so the header shows its account button rather than the tab bar.
test.use({ viewport: { width: 1280, height: 900 } })

async function signUp(page: Page) {
  const password = `Local-QA-${crypto.randomUUID()}`
  await page.goto(`${origin}/register`)
  const form = page.locator('form').filter({ has: page.locator('#name') })
  await form.getByLabel('Full Name', { exact: true }).fill('Avatar QA')
  await form.getByLabel('Email', { exact: true }).fill(`avatar-${crypto.randomUUID()}@example.test`)
  await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByLabel('Confirm Password', { exact: true }).fill(password)
  await page.locator('#terms').check()
  const registered = page.waitForResponse(r => r.url().endsWith('/api/register') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create Account', exact: true }).click()
  expect((await registered).ok()).toBeTruthy()
  await expect(page).not.toHaveURL(/\/register/)
}

function profileCard(page: Page) {
  return page.locator('section').filter({ has: page.getByRole('heading', { name: 'Profile', exact: true }) })
}

/** The header's account button, which holds the face. (Compete is a menu button too.) */
function accountButton(page: Page) {
  return page.locator('nav button[aria-haspopup="menu"]').filter({ hasText: 'Account' })
}

/** The router cross-fades pages; a screenshot mid-fade shows both. */
async function settled(page: Page) {
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {}))))
}

/** Whether an <img> has actually decoded, not merely been given a src. */
async function loaded(image: ReturnType<Page['locator']>) {
  await expect.poll(() => image.evaluate(el => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
}

test('a photo chosen in Settings becomes the face in the header', async ({ page }, testInfo) => {
  await signUp(page)
  await page.goto(`${origin}/settings`)
  const card = profileCard(page)
  await expect(card.getByText('Add photo')).toBeVisible()
  await expect(accountButton(page).locator('img')).toHaveCount(0)

  const uploaded = page.waitForResponse(r => r.url().endsWith('/api/me/avatar') && r.request().method() === 'POST')
  await card.locator('#profile-photo-input').setInputFiles({ name: 'me.jpg', mimeType: 'image/jpeg', buffer: photo })
  const response = await uploaded
  expect(response.status()).toBe(201)
  const body = await response.json()
  expect(body.user.avatar).toMatch(/^\/api\/avatars\/\d+\/[0-9a-f-]{36}\.jpg$/)

  // Settings shows the full-size photo, the header the thumbnail.
  const settingsPhoto = card.locator(`img[src="${body.user.avatar}"]`)
  await expect(settingsPhoto).toBeVisible()
  await loaded(settingsPhoto)
  await expect(card.getByText('Change photo')).toBeVisible()
  await expect(card.getByRole('button', { name: 'Remove photo' })).toBeVisible()

  const navPhoto = accountButton(page).locator('img')
  await expect(navPhoto).toHaveAttribute('src', body.user.avatar.replace(/\.jpg$/, '-thumb.jpg'))
  await loaded(navPhoto)

  await settled(page)
  await card.screenshot({ path: testInfo.outputPath('settings-profile-photo.png') })
  await page.locator('nav').first().screenshot({ path: testInfo.outputPath('nav-with-photo.png') })

  // /api/me carries it, so a fresh load still shows it.
  await page.reload()
  await expect(accountButton(page).locator('img')).toHaveAttribute('src', /-thumb\.jpg$/)
  await loaded(accountButton(page).locator('img'))

  // Other people see it too: in the athlete directory (a list rendered in a
  // loop) and on the public profile.
  const thumb = body.user.avatar.replace(/\.jpg$/, '-thumb.jpg')
  await page.goto(`${origin}/athletes`)
  const listed = page.locator(`main img[src="${thumb}"]`)
  await expect(listed.first()).toBeVisible()
  await loaded(listed.first())
  await page.goto(`${origin}/athlete/${body.user.id}`)
  const header = page.locator(`main img[src="${body.user.avatar}"]`)
  await expect(header).toBeVisible()
  await loaded(header)
  await settled(page)
  await page.locator('main section').first().screenshot({ path: testInfo.outputPath('athlete-header.png') })
  await page.goto(`${origin}/settings`)

  // The file route serves the current photo, and nothing once it is removed.
  expect((await page.request.get(`${origin}${body.user.avatar}`)).status()).toBe(200)
  const removed = page.waitForResponse(r => r.url().endsWith('/api/me/avatar') && r.request().method() === 'DELETE')
  await profileCard(page).getByRole('button', { name: 'Remove photo' }).click()
  expect((await removed).ok()).toBeTruthy()
  await expect(accountButton(page).locator('img')).toHaveCount(0)
  await expect(profileCard(page).getByText('Add photo')).toBeVisible()
  expect((await page.request.get(`${origin}${body.user.avatar}`)).status()).toBe(404)
})

test('name, bio and location save and come back after a reload', async ({ page }) => {
  await signUp(page)
  await page.goto(`${origin}/settings`)
  const card = profileCard(page)

  await card.getByLabel('Name').fill('Avatar QA Runner')
  await card.getByLabel('Location').fill('Boulder, CO')
  await card.getByLabel('Bio').fill('Hills, mostly.')
  const saved = page.waitForResponse(r => r.url().endsWith('/api/me/profile') && r.request().method() === 'PUT')
  await card.getByRole('button', { name: 'Save profile' }).click()
  expect((await saved).ok()).toBeTruthy()
  await expect(card.getByText('Profile saved.')).toBeVisible()

  await page.reload()
  await expect(profileCard(page).getByLabel('Location')).toHaveValue('Boulder, CO')
  await expect(profileCard(page).getByLabel('Bio')).toHaveValue('Hills, mostly.')
  await expect(profileCard(page).getByLabel('Name')).toHaveValue('Avatar QA Runner')
})

test('a name that is too short is refused next to the field, without a request', async ({ page }) => {
  await signUp(page)
  await page.goto(`${origin}/settings`)
  const card = profileCard(page)
  let sent = false
  page.on('request', (request) => {
    if (request.url().endsWith('/api/me/profile'))
      sent = true
  })
  await card.getByLabel('Name').fill('A')
  await card.getByRole('button', { name: 'Save profile' }).click()
  await expect(card.getByText('Your name needs at least 2 characters.')).toBeVisible()
  expect(sent).toBe(false)
})

test('every page that shows faces renders them without a template error', async ({ page }) => {
  await signUp(page)
  const problems: string[] = []
  page.on('console', (message) => {
    const text = message.text()
    if (/hydration invariant|is not defined|photoOf|facePhoto|accountFace|athleteFace|reviewerPhoto|ownerPhoto|athletePhoto|accountPhoto/.test(text))
      problems.push(`${page.url()}: ${text}`)
  })
  page.on('pageerror', error => problems.push(`${page.url()}: ${error.message}`))

  for (const path of ['/feed', '/leaderboard', '/athletes', '/battles', '/challenges', '/conquests', '/search?q=Avatar', '/menu', '/settings'])
    await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' })

  expect(problems).toEqual([])
})

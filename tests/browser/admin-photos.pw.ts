import { expect, test } from '@playwright/test'
import { QA_ADMIN } from './qa-admin'
import { QA_PORTS } from './qa-ports'

/**
 * /admin/photos says how each candidate was found (#1006).
 *
 * A file found near the trail head and one found by searching for the
 * trail's name are different evidence — the second may have no location at
 * all — so the reviewer is told which is which, and how far from the trail a
 * located one lies. The labels are rendered on the client, so only a browser
 * sees them. Nothing here approves anything.
 */

const origin = `http://127.0.0.1:${QA_PORTS.proxy}`

test.use({ viewport: { width: 1280, height: 900 } })

test('the review page says how each photo was found, and credits authors by name', async ({ page }, testInfo) => {
  await page.goto(`${origin}/login`)
  await page.locator('#email').fill(QA_ADMIN.email)
  await page.locator('#password').fill(QA_ADMIN.password)
  const signedIn = page.waitForResponse(r => r.url().endsWith('/api/login') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Sign In', exact: true }).click()
  expect((await signedIn).ok()).toBeTruthy()
  await expect(page).not.toHaveURL(/\/login/)

  await page.goto(`${origin}/admin/photos`)

  const cathedral = page.locator('li').filter({ has: page.getByRole('link', { name: 'Cathedral Rock Trail', exact: true }) }).first()
  await expect(cathedral).toBeVisible()

  const card = (title: string) => cathedral.locator('li').filter({ has: page.getByRole('link', { name: title, exact: true }) })

  const unlocated = card('Cathedral Rock from Red Rock Crossing.jpg')
  await expect(unlocated.getByText('Found by name · no location on the file')).toBeVisible()
  // "QA Walker (talk · contribs)" on Commons.
  await expect(unlocated.getByText('By QA Walker', { exact: true })).toBeVisible()

  const located = card('Cathedral Rock saddle view.jpg')
  await expect(located.getByText(/^Found by name · \d+ m from the trail$/)).toBeVisible()
  await expect(located.getByText('By QA Summiteer', { exact: true })).toBeVisible()

  await expect(card('Cathedral Rock trailhead sign.jpg').getByText('Taken near the trail head')).toBeVisible()

  await cathedral.screenshot({ path: testInfo.outputPath('admin-photos-cathedral-rock.png') })
})

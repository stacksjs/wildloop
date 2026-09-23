import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'

const origin = 'http://127.0.0.1:4322'

async function startHike(page: Page) {
  const email = `browser-${crypto.randomUUID()}@example.test`
  const password = `Local-QA-${crypto.randomUUID()}`
  await page.goto(`${origin}/register`)
  const registration = page.locator('form').filter({ has: page.locator('#name') })
  await registration.getByLabel('Full Name', { exact: true }).fill('Browser Hike QA')
  await registration.getByLabel('Email', { exact: true }).fill(email)
  await registration.getByLabel('Password', { exact: true }).fill(password)
  await registration.getByLabel('Confirm Password', { exact: true }).fill(password)
  await page.locator('#terms').check()
  const registered = page.waitForResponse(response => response.url().endsWith('/api/register') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create Account', exact: true }).click()
  expect((await registered).ok()).toBeTruthy()
  await expect(page).not.toHaveURL(/\/register/)
  await page.goto(`${origin}/record`)
  await page.getByRole('button', { name: 'Options', exact: true }).click()
  await page.getByLabel('Activity', { exact: true }).selectOption('Hike')
  await page.getByLabel('Who can see it').selectOption('private')
  await page.getByRole('button', { name: 'Free run', exact: true }).click()
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Finish recording', exact: true })).toBeVisible()
  // Let real time pass between synthetic fixes, preserving valid speed/acceleration.
  for (let index = 0; index < 3; index++) {
    await page.waitForTimeout(2200)
    await page.getByRole('button', { name: 'Advance GPS', exact: true }).click()
  }
  await expect(page.locator('fieldset output')).toContainText('1 watchers')
  return { email, password }
}

test('fresh account can recover a rejected hike, export it and upload exactly once', async ({ page }, testInfo) => {
  await startHike(page)
  let refusedUploadId = ''
  await page.route('**/api/activities', async route => {
    if (route.request().method() !== 'POST') return route.continue()
    refusedUploadId = route.request().postDataJSON().upload_id
    await route.fulfill({ status: 422, json: { error: 'Validation failed', fields: { gpx_data: 'QA: track needs review' } } })
  })
  await page.getByRole('button', { name: 'Finish recording', exact: true }).click()
  const recovery = page.getByRole('region', { name: 'Recordings on this device' })
  await expect(recovery).toContainText('Automatic retries stopped')
  await expect(recovery).toContainText('QA: track needs review')
  await page.reload()
  await expect(recovery).toContainText('QA: track needs review')
  await recovery.screenshot({ path: testInfo.outputPath('recovery-mobile.png') })
  const download = page.waitForEvent('download')
  await recovery.getByRole('button', { name: 'Export backup' }).click()
  const file = await download
  const stream = await file.createReadStream()
  const chunks = []
  for await (const chunk of stream!) chunks.push(chunk)
  const backup = JSON.parse(Buffer.concat(chunks).toString())
  expect(backup.recording.payload.upload_id).toBe(refusedUploadId)
  expect(backup.recording.payload.activity_type).toBe('Hike')
  expect(JSON.parse(backup.recording.payload.gpx_data).coordinates).toHaveLength(4)
  await expect(recovery).toBeVisible()
  await page.unroute('**/api/activities')
  const saved = page.waitForResponse(response => response.url().endsWith('/api/activities') && response.request().method() === 'POST')
  await recovery.getByRole('button', { name: 'Retry upload' }).click()
  const response = await saved
  expect(response.ok(), await response.text()).toBeTruthy()
  expect(response.request().postDataJSON().upload_id).toBe(refusedUploadId)
  const { activity } = await response.json()
  await expect(recovery).toBeHidden()
  await page.goto(`${origin}/activity/${activity.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Hike')
})

test('failed upload and queue retain a finished hike through reload', async ({ page }) => {
  await startHike(page)
  await page.getByRole('link', { name: 'Feed', exact: true }).first().click()
  await expect(page).toHaveURL(`${origin}/record`)
  await page.getByLabel('Fail uploads', { exact: true }).check()
  await page.getByLabel('Fail queue', { exact: true }).check()
  let uploadId = ''
  page.on('request', request => {
    if (request.url().endsWith('/api/activities') && request.method() === 'POST')
      uploadId = request.postDataJSON().upload_id
  })
  await page.getByRole('button', { name: 'Finish recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Retry saving', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Start recording', exact: true })).toBeHidden()
  page.once('dialog', dialog => dialog.accept())
  await page.reload()
  await expect(page.getByRole('button', { name: 'Retry saving', exact: true })).toBeVisible()
  const saved = page.waitForResponse(response => response.url().endsWith('/api/activities') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Retry saving', exact: true }).click()
  const response = await saved
  expect(response.ok(), await response.text()).toBeTruthy()
  expect(uploadId).toBeTruthy()
  const { activity } = await response.json()
  await page.goto(`${origin}/activity/${activity.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Hike')
})

test('API stores GPS time, deduplicates retries and refuses foreign/guest access', async () => {
  const { stdout } = await promisify(execFile)('bun', ['scripts/test-recording-api.ts'], { cwd: new URL('../..', import.meta.url) })
  expect(stdout).toContain('PASS:')
})

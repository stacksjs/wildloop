import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, test, type Page } from '@playwright/test'

const origin = 'http://127.0.0.1:4322'
let pageErrors: string[] = []
test.beforeEach(async ({ page }) => {
  pageErrors = []
  page.on('pageerror', error => pageErrors.push(error.message))
})
test.afterEach(() => expect(pageErrors, 'No uncaught client runtime errors').toEqual([]))

function durationSeconds(time: string) {
  return time.split(':').reduce((total, value) => total * 60 + Number(value), 0)
}

async function startHike(page: Page, denyLocationFirst = false) {
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
  if (denyLocationFirst) {
    await page.getByLabel('Deny location', { exact: true }).check()
    await page.getByRole('button', { name: 'Start recording', exact: true }).click()
    await expect(page.getByRole('alert', { name: /Location access is off/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Finish recording', exact: true })).toBeHidden()
    await page.getByRole('button', { name: 'Advance GPS', exact: true }).click()
    await expect(page.locator('fieldset output')).toContainText('0 watchers')
    await page.getByLabel('Deny location', { exact: true }).uncheck()
  }
  await page.getByRole('button', { name: 'Start recording', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Finish recording', exact: true })).toBeVisible()
  if (denyLocationFirst) {
    await page.getByRole('button', { name: 'Finish recording', exact: true }).click()
    await expect(page.getByRole('alert', { name: /Not enough GPS points/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Finish recording', exact: true })).toBeVisible()
  }
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

test('location refusal can be retried and paused recovery keeps one GPS watcher', async ({ page }) => {
  await startHike(page, true)
  await page.getByRole('button', { name: 'Pause recording', exact: true }).click()
  const clock = page.getByLabel('Elapsed time', { exact: true })
  const pausedTime = await clock.textContent()
  await page.waitForTimeout(3000)
  await page.getByRole('button', { name: 'Advance GPS', exact: true }).click()
  await expect(clock).toHaveText(pausedTime!)
  page.once('dialog', dialog => dialog.accept())
  await page.reload()
  await expect(page.getByRole('button', { name: 'Resume recording', exact: true })).toBeVisible()
  await expect(clock).toHaveText(pausedTime!)
  await page.getByRole('button', { name: 'Advance GPS', exact: true }).click()
  await expect(page.locator('fieldset output')).toContainText('1 watchers')
  await page.getByRole('button', { name: 'Resume recording', exact: true }).click()
  await page.waitForTimeout(2200)
  await expect.poll(async () => durationSeconds((await clock.textContent())!)).toBeGreaterThan(durationSeconds(pausedTime!))
  await page.getByRole('button', { name: 'Advance GPS', exact: true }).click()
  const saved = page.waitForResponse(response => response.url().endsWith('/api/activities') && response.request().method() === 'POST')
  await page.getByRole('button', { name: 'Finish recording', exact: true }).click()
  const response = await saved
  expect(response.ok(), await response.text()).toBeTruthy()
  const payload = response.request().postDataJSON()
  expect(JSON.parse(payload.gpx_data).coordinates).toHaveLength(5)
  expect(durationSeconds(payload.duration) - durationSeconds(payload.moving_time)).toBeGreaterThanOrEqual(3)
  const { activity } = await response.json()
  await page.goto(`${origin}/activity/${activity.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Hike')
})

test('finishing without network retains the hike and reconnect uploads the original track', async ({ page, context }) => {
  await startHike(page)
  await context.setOffline(true)
  await page.getByRole('button', { name: 'Finish recording', exact: true }).click()
  const recovery = page.getByRole('region', { name: 'Recordings on this device' })
  await expect(recovery).toBeVisible()
  const download = page.waitForEvent('download')
  await recovery.getByRole('button', { name: 'Export backup' }).click()
  const stream = await (await download).createReadStream()
  const chunks = []
  for await (const chunk of stream!) chunks.push(chunk)
  const backup = JSON.parse(Buffer.concat(chunks).toString())
  const original = backup.recording.payload
  expect(JSON.parse(original.gpx_data).coordinates).toHaveLength(4)
  const saved = page.waitForResponse(response => response.url().endsWith('/api/activities') && response.request().method() === 'POST')
  await context.setOffline(false)
  const response = await saved
  expect(response.ok(), await response.text()).toBeTruthy()
  expect(response.request().postDataJSON()).toEqual(original)
  const { activity } = await response.json()
  await expect(recovery).toBeHidden()
  await page.reload()
  await expect(recovery).toBeHidden()
  await page.goto(`${origin}/activity/${activity.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Hike')
})

test('session expiry finishes the original hike after in-place owner login', async ({ page }) => {
  const { email, password } = await startHike(page)
  const expired = page.waitForResponse(response => response.url().endsWith('/api/me') && response.status() === 401)
  await page.getByRole('button', { name: 'Expire session', exact: true }).click()
  await expired
  await page.getByRole('button', { name: 'Finish recording', exact: true }).click()
  const gate = page.getByRole('dialog', { name: 'Welcome back' })
  await expect(gate).toBeVisible()
  await expect(page).toHaveURL(`${origin}/record`)
  await gate.getByLabel('Email', { exact: true }).fill(email)
  await gate.getByLabel('Password', { exact: true }).fill(password)
  const saved = page.waitForResponse(response => response.url().endsWith('/api/activities') && response.request().method() === 'POST')
  await gate.locator('form').getByRole('button', { name: 'Log in', exact: true }).click()
  const response = await saved
  expect(response.ok(), await response.text()).toBeTruthy()
  expect(JSON.parse(response.request().postDataJSON().gpx_data).coordinates).toHaveLength(4)
  await expect(gate).toBeHidden()
  const { activity } = await response.json()
  await page.goto(`${origin}/activity/${activity.id}`)
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Hike')
})

test('reloading a resumed hike does not count an earlier pause as moving time', async ({ page }) => {
  await page.clock.install()
  await startHike(page)
  await page.getByRole('button', { name: 'Pause recording', exact: true }).click()
  await page.waitForTimeout(6000)
  await page.getByRole('button', { name: 'Resume recording', exact: true }).click()
  await page.waitForTimeout(2200)
  await page.getByRole('button', { name: 'Advance GPS', exact: true }).click()
  // A second pause/resume writes a checkpoint including the post-pause fix.
  await page.getByRole('button', { name: 'Pause recording', exact: true }).click()
  await page.waitForTimeout(300)
  // Pause fake time while the recorder is paused; the forward jump must not
  // add exercise time. Leave room for the browser-protocol round trip.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 60_000))
  await page.getByRole('button', { name: 'Resume recording', exact: true }).click()
  await page.waitForTimeout(300)
  const before = durationSeconds((await page.getByLabel('Elapsed time', { exact: true }).textContent())!)
  page.once('dialog', dialog => dialog.accept())
  await page.reload({ waitUntil: 'domcontentloaded' })
  // Advance only known time while the real page hydrates. Slow CI/network
  // loading must not be mistaken for the recovered clock counting a pause.
  let recoveryTicks = 0
  const pause = page.getByRole('button', { name: 'Pause recording', exact: true })
  await expect.poll(async () => {
    await page.clock.runFor(100)
    recoveryTicks += 100
    return pause.isVisible()
  }).toBe(true)
  await pause.click()
  const pausedAgain = await page.getByLabel('Elapsed time', { exact: true }).textContent()
  const after = durationSeconds(pausedAgain!)
  expect(after).toBeGreaterThanOrEqual(before - 1)
  expect(after).toBeLessThanOrEqual(before + Math.ceil(recoveryTicks / 1000))
  await page.clock.runFor(1500)
  await expect(page.getByLabel('Elapsed time', { exact: true })).toHaveText(pausedAgain!)
})

test('API stores GPS time, deduplicates retries and refuses foreign/guest access', async () => {
  const { stdout } = await promisify(execFile)('bun', ['scripts/test-recording-api.ts'], { cwd: new URL('../..', import.meta.url) })
  expect(stdout).toContain('PASS:')
})

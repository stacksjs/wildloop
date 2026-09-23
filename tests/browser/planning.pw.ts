import { expect, test, type Page } from '@playwright/test'

/**
 * Planning a trip somewhere else: find a town, see its trails, plan one for
 * a day, and have directions ready for Apple Maps and Google Maps — online
 * and from the copy on the device.
 *
 * Runs against the isolated QA stack (scripts/start-recording-qa.ts): a fresh
 * database with one trail, Torrey Pines Loop, and a five-town gazetteer, so
 * nothing here touches real accounts or downloads GeoNames.
 */

const origin = 'http://127.0.0.1:4322'
const TORREY_PINES = { lat: 32.9209, lng: -117.2528 }

async function signUp(page: Page) {
  const password = `Local-QA-${crypto.randomUUID()}`
  await page.goto(`${origin}/register`)
  const form = page.locator('form').filter({ has: page.locator('#name') })
  await form.getByLabel('Full Name', { exact: true }).fill('Planning QA')
  await form.getByLabel('Email', { exact: true }).fill(`plan-${crypto.randomUUID()}@example.test`)
  await form.getByLabel('Password', { exact: true }).fill(password)
  await form.getByLabel('Confirm Password', { exact: true }).fill(password)
  await page.locator('#terms').check()
  const registered = page.waitForResponse(r => r.url().endsWith('/api/register') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Create Account', exact: true }).click()
  expect((await registered).ok()).toBeTruthy()
  await expect(page).not.toHaveURL(/\/register/)
}

/** YYYY-MM-DD, `days` from today where the browser is. */
async function dateIn(page: Page, days: number): Promise<string> {
  return page.evaluate((n) => {
    const d = new Date()
    d.setDate(d.getDate() + n)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }, days)
}

test('plan a trail in another town a week out, with directions ready online and offline', async ({ page }, testInfo) => {
  await signUp(page)

  // Where to? A town, then the trails near it.
  await page.goto(`${origin}/plans`)
  await page.getByPlaceholder(/Where to\?/).fill('San Diego')
  // Two San Diegos in the extract (California and Texas); the city ranks first.
  const results = page.getByRole('list').filter({ hasText: 'San Diego' }).first()
  await expect(results.getByRole('listitem')).toHaveCount(2)
  await results.getByRole('link', { name: 'Trails' }).first().click()
  await expect(page).toHaveURL(/\/trails\?near=San\+Diego&lat=32\.71571&lng=-117\.16472/)
  await expect(page.getByText('Near San Diego', { exact: false }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: 'Plan a run here' })).toBeVisible()

  // The trail, and a visit to it a week from today.
  await page.getByRole('link', { name: /Torrey Pines Loop/ }).first().click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Torrey Pines Loop')
  const inAWeek = await dateIn(page, 7)
  await page.getByRole('button', { name: 'Plan', exact: true }).click()
  const sheet = page.getByRole('dialog', { name: 'Plan a visit' })
  await expect(sheet).toBeVisible()
  await sheet.getByLabel('Date').fill(inAWeek)
  await sheet.getByLabel(/Start/).fill('07:30')
  await sheet.getByLabel(/Notes/).fill('Park at the south lot.')
  const saved = page.waitForResponse(r => r.url().endsWith('/api/plans') && r.request().method() === 'POST')
  await sheet.getByRole('button', { name: 'Save plan' }).click()
  const response = await saved
  expect(response.status(), await response.text()).toBe(201)
  const { plan } = await response.json()
  expect(plan).toMatchObject({ title: 'Torrey Pines Loop', planned_for: inAWeek, start_time: '07:30', latitude: TORREY_PINES.lat, longitude: TORREY_PINES.lng })
  await expect(sheet).toBeHidden()
  await expect(page.getByRole('link', { name: /Planned for .* 7:30 AM/ })).toBeVisible()

  // Directions on the trail page go to the trailhead in both apps.
  const apple = `https://maps.apple.com/?daddr=${TORREY_PINES.lat}%2C${TORREY_PINES.lng}&dirflg=d`
  const google = `https://www.google.com/maps/dir/?api=1&destination=${TORREY_PINES.lat}%2C${TORREY_PINES.lng}&travelmode=driving`
  await expect(page.getByRole('link', { name: 'Apple Maps' }).first()).toHaveAttribute('href', apple)
  await expect(page.getByRole('link', { name: 'Google Maps' }).first()).toHaveAttribute('href', google)

  // The plans page: the day, the notes, and the same two links.
  await page.goto(`${origin}/plans`)
  const card = page.locator(`#plan-${plan.id}`)
  await expect(card).toContainText('Torrey Pines Loop')
  await expect(card).toContainText('7:30 AM')
  await expect(card).toContainText('Park at the south lot.')
  await expect(card).toContainText('in 7 days')
  await expect(card.getByRole('link', { name: 'Apple Maps' })).toHaveAttribute('href', apple)
  await expect(card.getByRole('link', { name: 'Google Maps' })).toHaveAttribute('href', google)
  await expect(card.getByRole('link', { name: 'Apple Maps' })).toHaveAttribute('target', '_blank')
  await card.screenshot({ path: testInfo.outputPath('plan-card.png') })

  // No connection: the device copy, said so, with directions intact.
  await page.route('**/api/plans', route => route.abort('internetdisconnected'))
  await page.reload()
  await expect(page.getByText(/Offline — showing the plans saved on this device/)).toBeVisible()
  await expect(page.locator(`#plan-${plan.id}`).getByRole('link', { name: 'Apple Maps' })).toHaveAttribute('href', apple)
})

test('plan a spot that is not a trail by searching a town', async ({ page }) => {
  await signUp(page)
  await page.goto(`${origin}/plans`)
  await expect(page.getByText('Nothing planned yet')).toBeVisible()

  await page.getByRole('button', { name: 'Plan a spot' }).click()
  const sheet = page.getByRole('dialog', { name: 'Plan a spot' })
  await sheet.getByPlaceholder('Town or city').fill('chamonix')
  await sheet.getByRole('button', { name: /Chamonix-Mont-Blanc/ }).click()
  await expect(sheet.getByText(/Pinned near Chamonix-Mont-Blanc/)).toBeVisible()
  await expect(sheet.getByLabel('Name')).toHaveValue('Run in Chamonix-Mont-Blanc')
  await sheet.getByLabel('Date').fill(await dateIn(page, 3))

  const saved = page.waitForResponse(r => r.url().endsWith('/api/plans') && r.request().method() === 'POST')
  await sheet.getByRole('button', { name: 'Save plan' }).click()
  expect((await saved).status()).toBe(201)
  await expect(sheet).toBeHidden()

  const card = page.locator('article').filter({ hasText: 'Run in Chamonix-Mont-Blanc' })
  await expect(card.getByRole('link', { name: 'Apple Maps' })).toHaveAttribute('href', 'https://maps.apple.com/?daddr=45.92375%2C6.86933&dirflg=d')
  await expect(card.getByRole('link', { name: 'Trails nearby' })).toBeVisible()

  // Cancelling takes it off the list.
  await card.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByText('Nothing planned yet')).toBeVisible()
})

test('draw a route in a town, save it, plan it for a day, and open it again', async ({ page }) => {
  await signUp(page)
  await page.goto(`${origin}/routes`)
  await page.waitForFunction(() => (document.getElementById('route-builder-map')?.children.length ?? 0) > 0)

  await page.getByPlaceholder(/Start in/).fill('San Diego')
  await page.getByRole('button', { name: /San Diego/ }).first().click()
  await expect(page.getByText('Tap the map in San Diego to set your start.')).toBeVisible()
  // Straight legs: path routing is a network call to Valhalla, and a deploy
  // gate must not depend on a public server.
  await page.getByRole('button', { name: 'Straight' }).click()

  const map = page.locator('#route-builder-map')
  await map.click({ position: { x: 80, y: 90 } })
  await expect(page.getByText('Now tap where you want to go')).toBeVisible()
  await map.click({ position: { x: 220, y: 120 } })
  await map.click({ position: { x: 160, y: 230 } })
  await page.getByRole('button', { name: 'Loop back' }).click()
  await expect(page.getByText(/\d+\.\d+ mi.* · loop/)).toBeVisible()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText(/ · loop/)).toBeHidden()
  await page.getByRole('button', { name: 'Loop back' }).click()
  await expect(page.getByText(/ · loop/)).toBeVisible()

  await page.locator('#route-name').fill('Harbor loop')
  const saved = page.waitForResponse(r => r.url().endsWith('/api/custom-routes') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Save route' }).click()
  const response = await saved
  expect(response.status(), await response.text()).toBe(201)
  const { route } = await response.json()
  expect(route.closedLoop).toBe(true)
  await expect(page.getByText('Saved “Harbor loop”.')).toBeVisible()

  // Plan it: the planner opens on the route's start, under its name.
  await page.getByRole('link', { name: 'Plan this route' }).click()
  await expect(page).toHaveURL(new RegExp(`/plans\\?route=${route.id}`))
  const sheet = page.getByRole('dialog', { name: 'Plan this route' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByLabel('Name')).toHaveValue('Harbor loop')
  await sheet.getByLabel('Date').fill(await dateIn(page, 8))
  const planned = page.waitForResponse(r => r.url().endsWith('/api/plans') && r.request().method() === 'POST')
  await sheet.getByRole('button', { name: 'Save plan' }).click()
  const planResponse = await planned
  expect(planResponse.status(), await planResponse.text()).toBe(201)
  const { plan } = await planResponse.json()
  const [startLat, startLng] = route.route[0]
  expect(plan).toMatchObject({ custom_route_id: route.id, title: 'Harbor loop', latitude: startLat, longitude: startLng })

  const card = page.locator(`#plan-${plan.id}`)
  const six = (n: number) => String(Number(n.toFixed(6)))
  await expect(card.getByRole('link', { name: 'Apple Maps' })).toHaveAttribute('href', `https://maps.apple.com/?daddr=${six(startLat)}%2C${six(startLng)}&dirflg=d`)
  await card.getByRole('link', { name: 'Route' }).click()
  await expect(page).toHaveURL(new RegExp(`/routes\\?open=${route.id}`))
  await expect(page.getByText(/ · loop/)).toBeVisible()
  await expect(page.locator('#route-name')).toHaveValue('Harbor loop')
})

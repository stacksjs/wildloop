import { expect, test } from '@playwright/test'

/**
 * "Search this area": moving the map offers to search what it now shows, and
 * the search keeps the view it was asked from.
 *
 * Runs against the isolated QA stack (scripts/start-recording-qa.ts), whose
 * catalog has four trails on Santa Barbara Island.
 */

const origin = 'http://127.0.0.1:4322'

test('moving the map offers to search there, and the search keeps the view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${origin}/trails?country=all`)
  await expect(page.getByRole('heading', { name: 'Elephant Seal Cove Loop Trail' })).toBeVisible()

  // The page fitting the map to its own results is not the person moving it.
  const searchArea = page.getByRole('button', { name: 'Search this area' })
  await page.waitForTimeout(1500)
  await expect(searchArea).toHaveCount(0)

  // Zooming in with the map's own control is.
  await page.getByRole('button', { name: 'Zoom in' }).click()
  await expect(searchArea).toBeVisible()

  // Aim the view at the island, then search it.
  await page.evaluate(() => {
    const map = (document.getElementById('trails-explore-map') as any)._tsMap
    map.setView([33.48, -119.03], 12, { animate: false })
  })
  const searched = page.waitForResponse(r => r.url().includes('/api/trails?') && r.url().includes('lat=33.48'))
  await searchArea.click()
  const url = new URL((await searched).url())
  expect(Number(url.searchParams.get('radius'))).toBeGreaterThan(0)
  expect(Number(url.searchParams.get('radius'))).toBeLessThanOrEqual(300)

  await expect(page.getByRole('heading', { level: 1 })).toContainText('Popular trails near')
  await expect(page.getByRole('heading', { name: 'Signal Peak Loop' })).toBeVisible()
  await expect(searchArea).toHaveCount(0)

  // Drawn on the view it was searched from, not refitted away from it.
  const view = await page.evaluate(() => {
    const map = (document.getElementById('trails-explore-map') as any)._tsMap
    return { zoom: map.getZoom(), center: map.getCenter() }
  })
  expect(view.zoom).toBe(12)
  expect(view.center.lat).toBeCloseTo(33.48, 1)
})

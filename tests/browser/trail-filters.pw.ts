import { expect, test } from '@playwright/test'

/**
 * Where to look, as dropdowns in the filter row: country, then a region
 * inside it. They were two rows of pills above and below the filters.
 *
 * Runs against the isolated QA stack (scripts/start-recording-qa.ts): its
 * trails are all in California, whose region the QA catalog names by code,
 * CA. One country, so no Country chip, and one region to pick.
 */

const origin = 'http://127.0.0.1:4322'

test('pick a region from the Region dropdown, and go back to all regions', async ({ page }) => {
  await page.goto(`${origin}/trails?country=all`)

  const region = page.getByRole('button', { name: 'Region', exact: true })
  await expect(region).toBeVisible()
  await expect(page.getByRole('button', { name: /^Everywhere/ })).toHaveCount(0)

  await region.click()
  await expect(region).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('button', { name: /^CA \d/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trails in CA')
  const chosen = page.getByRole('button', { name: 'CA', exact: true })
  await expect(chosen).toBeVisible()

  await chosen.click()
  await page.getByRole('button', { name: 'All regions', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Region', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: /Torrey Pines Loop/ }).first()).toBeVisible()
})

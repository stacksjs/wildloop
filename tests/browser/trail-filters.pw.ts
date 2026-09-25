import { expect, test } from '@playwright/test'

/**
 * Where to look, as dropdowns in the filter row: country, then a region
 * inside it. They were two rows of pills above and below the filters.
 *
 * Runs against the isolated QA stack (scripts/start-recording-qa.ts), whose
 * catalog covers California, two German regions and one Austrian one — more
 * than one country, because the Country dropdown is offered only then, and
 * because a region outside the US is ISO 3166-2 (DE-BY) rather than the two
 * letters a US state is. tests/browser/trail-filters.test.ts holds the same
 * ground at the API.
 */

const origin = 'http://127.0.0.1:4322'

test('pick a country, then a region inside it, and come back out', async ({ page }) => {
  await page.goto(`${origin}/trails?country=all`)

  const country = page.getByRole('button', { name: 'Everywhere', exact: true })
  await expect(country).toBeVisible()
  await expect(page.getByRole('button', { name: 'Region', exact: true })).toBeVisible()

  await country.click()
  await expect(country).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('button', { name: /^Germany \d/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Every trail in Germany')
  await expect(page.getByRole('button', { name: 'Germany', exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: /Torrey Pines Loop/ })).toHaveCount(0)

  // Only the regions of the country in view, with their counts.
  const region = page.getByRole('button', { name: 'Region', exact: true })
  await region.click()
  await expect(page.getByRole('button', { name: /^Bayern 2\b/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Nordrhein-Westfalen \d/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /^CA \d/ })).toHaveCount(0)

  await page.getByRole('button', { name: /^Bayern \d/ }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trails in Bayern')
  await expect(page.getByRole('link', { name: /Partnachklamm Loop/ }).first()).toBeVisible()
  await expect(page.getByRole('link', { name: /Eifel Forest Way/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Bayern', exact: true }).click()
  await page.getByRole('button', { name: 'All regions', exact: true }).click()
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Every trail in Germany')

  await page.getByRole('button', { name: 'Germany', exact: true }).click()
  await page.getByRole('button', { name: /^Everywhere \d/ }).click()
  await expect(page.getByRole('link', { name: /Torrey Pines Loop/ }).first()).toBeVisible()
})

test('changing country drops a region that is not in it', async ({ page }) => {
  await page.goto(`${origin}/trails?country=DE&state=DE-BY`)
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Trails in Bayern')
  await expect(page.getByRole('button', { name: 'Bayern', exact: true })).toBeVisible()

  // DE-BY inside Austria matches nothing: a dead end with two chips lit.
  await page.getByRole('button', { name: 'Germany', exact: true }).click()
  await page.getByRole('button', { name: /^Austria \d/ }).click()

  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Every trail in Austria')
  await expect(page.getByRole('button', { name: 'Region', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Bayern', exact: true })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Nordkette Panorama Trail/ }).first()).toBeVisible()
})

test('pick a US state, where the region is named by its code', async ({ page }) => {
  await page.goto(`${origin}/trails?country=US`)

  const region = page.getByRole('button', { name: 'Region', exact: true })
  await expect(region).toBeVisible()
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

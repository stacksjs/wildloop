import { expect, test } from '@playwright/test'

test('recordings survive storage faults and rejected uploads', async ({ page }) => {
  await page.goto('http://127.0.0.1:4319')
  await page.getByRole('button', { name: 'Run storage tests' }).click()
  await expect(page.locator('pre')).toHaveText(/^PASS:/)
})

import { expect, test } from '@playwright/test'
import { QA_PORTS } from './qa-ports'

test('recordings survive storage faults and rejected uploads', async ({ page }) => {
  await page.goto(`http://127.0.0.1:${QA_PORTS.recorder}`)
  await page.getByRole('button', { name: 'Run storage tests' }).click()
  await expect(page.locator('pre')).toHaveText(/^PASS:/)
})

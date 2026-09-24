import { expect, test } from '@playwright/test'

// The catalog assertions moved to `trail-area-photos.test.ts`, which needs no
// browser. What stays here needs one: the label is rendered on the client, so
// it is absent from the served HTML and only a real browser can see it.

test('a trail page labels an island-area photo instead of passing it off as the trail', async ({ page, request }) => {
  const result = await request.get('http://127.0.0.1:4321/api/trails', {
    params: { country: 'all', limit: '10' },
  })
  expect(result.status()).toBe(200)
  const body = await result.json()
  const trail = body.trails.find((row: { source_id: string }) => row.source_id === 'nps/CHIS|ARCH POINT LOOP TRAIL')
  expect(trail).toBeDefined()

  await page.goto(`http://127.0.0.1:4320/trail/${trail.id}`)
  await expect(page.getByText('Santa Barbara Island area photo')).toBeVisible()
  await expect(page.getByRole('img', { name: 'Photo of Santa Barbara Island area' })).toBeVisible()
})

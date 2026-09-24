import { expect, test } from '@playwright/test'

test('the four Santa Barbara Island trails return attributed area photos rather than stock art', async ({ request }) => {
  const result = await request.get('http://127.0.0.1:4321/api/trails', {
    params: { country: 'all', limit: '10' },
  })
  expect(result.status(), await result.text()).toBe(200)
  const body = await result.json()
  const expected = [
    { id: 'ARCH POINT LOOP TRAIL', file: 'Santabarbara_300.jpg', credit: 'Shane Anderson/NOAA', license: 'Public domain' },
    { id: 'CAVE CANYON NATURE TRAIL', file: 'Seagulls_-_Santa_Barbara_Island.JPG', credit: 'Brian MacIntosh', license: 'CC BY-SA 4.0' },
    { id: 'ELEPHANT SEAL COVE LOOP TRAIL', file: 'Santa-Barbara-Island-Sea-Lion-Rookery.jpg', credit: 'National Park Service', license: 'Public domain' },
    { id: 'SIGNAL PEAK LOOP', file: 'Sutil_Island_-_Santa_Barbara_Island.JPG', credit: 'Brian MacIntosh', license: 'CC BY-SA 4.0' },
  ]
  for (const photo of expected) {
    const trail = body.trails.find((row: { source_id: string }) => row.source_id === `nps/CHIS|${photo.id}`)
    expect(trail, photo.id).toBeDefined()
    expect(trail.image, photo.id).toContain(`commons.wikimedia.org/wiki/Special:FilePath/${photo.file}`)
    expect(trail.coverCredit).toBe(photo.credit)
    expect(trail.coverScope).toBe('area')
    expect(trail.coverPlace).toBe('Santa Barbara Island')
    expect(trail.coverSourceUrl).toContain(`commons.wikimedia.org/wiki/File:${photo.file}`)
    expect(trail.coverLicense).toBe(photo.license)
    expect(trail.coverLicenseUrl).toContain(photo.license === 'Public domain' ? 'commons.wikimedia.org' : 'creativecommons.org/licenses/by-sa/4.0/')
  }
})

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

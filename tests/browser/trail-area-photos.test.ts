/**
 * The four Santa Barbara Island trails carry an attributed photo of the island
 * rather than stock art, and a trail page says so rather than passing the
 * photo off as the trail itself.
 *
 * Ported from `trail-area-photos.pw.ts`, which only ever used Playwright's
 * HTTP client for this half. The page half stays in that spec: the label is
 * rendered on the client, so it exists only after hydration in a real
 * browser — it is not in the HTML the server sends.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { API, READY_TIMEOUT_MS, startQaServers, stopQaServers } from './qa-servers'

// These boot the isolated QA app, so the ordinary `bun test` run skips them.
// CI runs them in the browser job, where the servers belong: RECORDING_QA=1.
const qa = process.env.RECORDING_QA === '1'

interface TrailRow {
  id: number
  source_id: string
  image: string
  coverCredit: string
  coverScope: string
  coverPlace: string
  coverSourceUrl: string
  coverLicense: string
  coverLicenseUrl: string
}

const EXPECTED = [
  { id: 'ARCH POINT LOOP TRAIL', file: 'Santabarbara_300.jpg', credit: 'Shane Anderson/NOAA', license: 'Public domain' },
  { id: 'CAVE CANYON NATURE TRAIL', file: 'Seagulls_-_Santa_Barbara_Island.JPG', credit: 'Brian MacIntosh', license: 'CC BY-SA 4.0' },
  { id: 'ELEPHANT SEAL COVE LOOP TRAIL', file: 'Santa-Barbara-Island-Sea-Lion-Rookery.jpg', credit: 'National Park Service', license: 'Public domain' },
  { id: 'SIGNAL PEAK LOOP', file: 'Sutil_Island_-_Santa_Barbara_Island.JPG', credit: 'Brian MacIntosh', license: 'CC BY-SA 4.0' },
]

let trails: TrailRow[] = []

beforeAll(async () => {
  if (!qa)
    return
  await startQaServers()
  const result = await fetch(`${API}/trails?country=all&limit=10`)
  expect(result.status, await result.clone().text()).toBe(200)
  trails = (await result.json()).trails
}, READY_TIMEOUT_MS + 10_000)

afterAll(() => {
  stopQaServers()
})

describe.skipIf(!qa)('area photos', () => {
  it('attributes an island photo on every Santa Barbara Island trail', () => {
    for (const photo of EXPECTED) {
      const trail = trails.find(row => row.source_id === `nps/CHIS|${photo.id}`)
      expect(trail, photo.id).toBeDefined()
      expect(trail!.image, photo.id).toContain(`commons.wikimedia.org/wiki/Special:FilePath/${photo.file}`)
      expect(trail!.coverCredit).toBe(photo.credit)
      expect(trail!.coverScope).toBe('area')
      expect(trail!.coverPlace).toBe('Santa Barbara Island')
      expect(trail!.coverSourceUrl).toContain(`commons.wikimedia.org/wiki/File:${photo.file}`)
      expect(trail!.coverLicense).toBe(photo.license)
      expect(trail!.coverLicenseUrl).toContain(photo.license === 'Public domain'
        ? 'commons.wikimedia.org'
        : 'creativecommons.org/licenses/by-sa/4.0/')
    }
  })

})

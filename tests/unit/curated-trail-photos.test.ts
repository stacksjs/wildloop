import { describe, expect, it } from 'bun:test'
import { applyCuratedTrailPhoto, CURATED_TRAIL_PHOTOS } from '../../app/Support/curatedTrailPhotos'

describe('reviewed trail photo seed', () => {
  /*
   * The invariant is per photo, not a count. Pinning the length to three meant
   * adding a reviewed photograph failed this test, which is the one thing the
   * list exists to make easy (#1006).
   */
  it('has explicit credit and a reusable license for every photo', () => {
    expect(CURATED_TRAIL_PHOTOS.length).toBeGreaterThan(0)

    for (const photo of CURATED_TRAIL_PHOTOS) {
      expect(photo.credit.length, photo.file).toBeGreaterThan(0)
      // Attribution licenses only. A photo whose terms we cannot state is one
      // we cannot publish beside a credit line.
      expect(photo.license, photo.file).toMatch(/^CC BY(-SA)? \d/)
      expect(photo.licenseUrl, photo.file).toMatch(/^https:\/\/creativecommons\.org\/licenses\//)
    }
  })

  it('names every trail it claims a photo for', () => {
    for (const photo of CURATED_TRAIL_PHOTOS) {
      expect(photo.names.length, photo.file).toBeGreaterThan(0)
      expect(photo.file.length, 'file').toBeGreaterThan(0)
      // A coordinate is what stops a namesake trail elsewhere inheriting it.
      expect(Number.isFinite(photo.lat), photo.file).toBe(true)
      expect(Number.isFinite(photo.lng), photo.file).toBe(true)
    }
  })

  it('matches a named trail near its checked coordinate', () => {
    const trail = applyCuratedTrailPhoto({
      id: 12,
      name: 'Mist Trail to Vernal Fall',
      state: 'CA',
      latitude: 37.7327,
      longitude: -119.558,
      image: null,
    })
    expect(trail.image).toContain('Special:FilePath/Vernal_Fall_from_Mist_Trail')
    expect(trail.coverCredit).toBe('Fabio Achilli')
    expect(trail.coverSourceUrl).toContain('commons.wikimedia.org/wiki/File:')
    expect(trail.coverLicenseUrl).toBe('https://creativecommons.org/licenses/by/2.0/')

    // The seeder writes the URL, and the read path restores its attribution.
    const seeded = applyCuratedTrailPhoto({ ...trail })
    expect(seeded.coverCredit).toBe('Fabio Achilli')
    expect(seeded.coverSourceUrl).toBe(trail.coverSourceUrl)
  })

  it('does not attach a photo to a namesake in another location or replace an editor image', () => {
    const base = { name: 'Dipsea Trail', state: 'CA', latitude: 37.8916, longitude: -122.5460 }
    expect(applyCuratedTrailPhoto({ ...base, latitude: 34.0, image: null }).image).toBeNull()
    expect(applyCuratedTrailPhoto({ ...base, state: 'NY', image: null }).image).toBeNull()
    expect(applyCuratedTrailPhoto({ ...base, image: 'https://example.com/editor.jpg' }).image).toBe('https://example.com/editor.jpg')
  })
})

import { describe, expect, it } from 'bun:test'
import { applyCuratedTrailPhoto, CURATED_TRAIL_PHOTOS } from '../../app/Support/curatedTrailPhotos'

describe('reviewed trail photo seed', () => {
  it('has explicit credit and license for every photo', () => {
    expect(CURATED_TRAIL_PHOTOS).toHaveLength(3)
    for (const photo of CURATED_TRAIL_PHOTOS) {
      expect(photo.credit.length).toBeGreaterThan(0)
      expect(photo.license).toBe('CC BY 2.0')
      expect(photo.licenseUrl).toBe('https://creativecommons.org/licenses/by/2.0/')
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

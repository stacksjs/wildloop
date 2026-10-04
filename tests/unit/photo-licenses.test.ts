import { describe, expect, it } from 'bun:test'
import { licenseLink, licenseVerdict } from '../../app/Support/photoLicenses'

/**
 * Which Commons licences a trail cover may carry (#1006).
 *
 * Wildloop has paid plans, so the line is commercial reuse with attribution
 * and nothing more asked. The failure that matters is a refusal read as an
 * acceptance: "CC BY-NC-SA" starts with "CC BY", and a cover under it is a
 * takedown waiting to happen.
 */

describe('licenseVerdict', () => {
  it.each([
    ['CC BY 2.0', 'cc-by'],
    ['CC-BY-4.0', 'cc-by'],
    ['CC BY 3.0 US', 'cc-by'],
    ['CC BY-SA 4.0', 'cc-by-sa'],
    ['CC-BY-SA-3.0-de', 'cc-by-sa'],
    ['CC BY-SA 3.0 migrated', 'cc-by-sa'],
    ['CC0', 'cc0'],
    ['Public domain', 'public-domain'],
    ['PD-US', 'public-domain'],
    ['PD-self', 'public-domain'],
  ])('accepts %s as %s', (name, family) => {
    const verdict = licenseVerdict(name)
    expect(verdict.allowed).toBe(true)
    expect(verdict.family).toBe(family as any)
    expect(verdict.reason).toBe('')
  })

  it.each([
    ['CC BY-NC-SA 2.0', 'non-commercial'],
    ['CC BY-NC 4.0', 'non-commercial'],
    ['CC BY-ND 2.0', 'no-derivatives'],
    ['CC BY-NC-ND 3.0', 'non-commercial'],
  ])('refuses %s as %s', (name, why) => {
    const verdict = licenseVerdict(name)
    expect(verdict.allowed).toBe(false)
    expect(verdict.family).toBeNull()
    expect(verdict.reason).toContain(why)
  })

  /* The short name is free text; the URL is the licence itself. */
  it('refuses a non-commercial licence URL whatever the short name says', () => {
    expect(licenseVerdict('CC BY 2.0', 'https://creativecommons.org/licenses/by-nc/2.0/').allowed).toBe(false)
    expect(licenseVerdict('CC BY 2.0', 'https://creativecommons.org/licenses/by-nd/2.0/').allowed).toBe(false)
  })

  it('reads CC0 and the public-domain mark from their URLs', () => {
    expect(licenseVerdict('Some dedication', 'https://creativecommons.org/publicdomain/zero/1.0/').family).toBe('cc0')
    expect(licenseVerdict('Marked', 'https://creativecommons.org/publicdomain/mark/1.0/').family).toBe('public-domain')
  })

  /* Statements about a file, or licences that ask for more than a credit. */
  it.each(['GFDL', 'Copyrighted free use', 'No restrictions', 'Attribution', 'CC BY-XY 1.0', 'All rights reserved'])('refuses %s', (name) => {
    expect(licenseVerdict(name).allowed).toBe(false)
  })

  it('refuses a file with no licence at all', () => {
    expect(licenseVerdict('')).toEqual({ allowed: false, family: null, reason: 'no licence recorded' })
    expect(licenseVerdict(null)).toMatchObject({ allowed: false })
    expect(licenseVerdict(undefined)).toMatchObject({ allowed: false })
  })
})

describe('licenseLink', () => {
  it('links the licence, over https', () => {
    expect(licenseLink('http://creativecommons.org/licenses/by-sa/3.0', 'https://commons.wikimedia.org/wiki/File:A.jpg'))
      .toBe('https://creativecommons.org/licenses/by-sa/3.0')
  })

  /* Public-domain files often have no licence URL; the file page says why. */
  it('falls back to the file page when Commons gives no licence URL', () => {
    expect(licenseLink('', 'https://commons.wikimedia.org/wiki/File:A.jpg')).toBe('https://commons.wikimedia.org/wiki/File:A.jpg')
    expect(licenseLink('javascript:alert(1)', 'https://commons.wikimedia.org/wiki/File:A.jpg')).toBe('https://commons.wikimedia.org/wiki/File:A.jpg')
    expect(licenseLink(null, null)).toBe('')
  })
})

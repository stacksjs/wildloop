import { describe, expect, it } from 'bun:test'
import { agrees, placeOfRegion, placeOfText } from '../../app/Support/placeText'

/**
 * Whether a gazetteer match is the place a club's location text names.
 *
 * The gazetteer answers "Bay Area, CA" with Qianhai Bay Area, Guangdong — its
 * most populous match. A club placed in China sorts as the far side of the
 * world for somebody in Los Angeles, which is worse than not placing it.
 */
const boulder = { regionCode: 'CO', region: 'Colorado', country: 'US', countryName: 'United States' }
const qianhai = { regionCode: '30', region: 'Guangdong', country: 'CN', countryName: 'China' }
const innsbruck = { regionCode: '07', region: 'Tyrol', country: 'AT', countryName: 'Austria' }

describe('a place agrees with what follows the comma', () => {
  it('matches a state or region code', () => {
    expect(agrees(boulder, 'co')).toBe(true)
    expect(agrees(qianhai, 'ca')).toBe(false)
  })

  it('matches a country code', () => {
    expect(agrees(innsbruck, 'at')).toBe(true)
    expect(agrees(boulder, 'at')).toBe(false)
  })

  it('matches a region or country by name', () => {
    expect(agrees(boulder, 'colorado')).toBe(true)
    expect(agrees(innsbruck, 'tyrol, austria')).toBe(true)
    expect(agrees(qianhai, 'california')).toBe(false)
  })

  it('accepts anything when nothing follows the comma', () => {
    expect(agrees(qianhai, '')).toBe(true)
  })
})

/**
 * Regions clubs write instead of a town. "Bay Area, CA" is not a GeoNames
 * town, so a Bay Area club was never placed, and an LA visitor saw it sorted
 * after every club that was.
 */
describe('a club named after a region', () => {
  const losAngeles = { lat: 34.0522, lng: -118.2437 }
  const km = (a: { lat: number, lng: number }, b: { lat: number, lng: number }) =>
    Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 111 * Math.cos(a.lat * Math.PI / 180))

  it('is placed in the region, near enough to sort by', () => {
    const bayArea = placeOfRegion('Bay Area, CA')
    expect(bayArea).not.toBeNull()
    // Oakland, roughly: 520-570 km from LA, not the far side of the world.
    expect(km(losAngeles, bayArea!)).toBeGreaterThan(500)
    expect(km(losAngeles, bayArea!)).toBeLessThan(600)

    const inlandEmpire = placeOfRegion('Inland Empire, CA')
    expect(km(losAngeles, inlandEmpire!)).toBeLessThan(100)
  })

  it('places it through placeOfText, with or without the gazetteer', () => {
    expect(placeOfText('Bay Area, CA')).toEqual(placeOfRegion('Bay Area, CA'))
    expect(placeOfText('Front Range, CO')).not.toBeNull()
  })

  it('reads every spelling a club writes', () => {
    const allgau = placeOfRegion('Allgäu')
    expect(allgau).not.toBeNull()
    expect(placeOfRegion('Allgau, Bayern')).toEqual(allgau)
    expect(placeOfRegion('allgäu, Bavaria')).toEqual(allgau)
    expect(placeOfRegion('Allgäu, DE')).toEqual(allgau)
    expect(placeOfRegion('The Tri-State Area')).toEqual(placeOfRegion('Tri-State Area, NJ'))
    expect(placeOfRegion('SF Bay Area')).toEqual(placeOfRegion('Bay Area'))
    expect(placeOfRegion('Bay Area, California')).toEqual(placeOfRegion('Bay Area'))
    expect(placeOfRegion('Berner Oberland, CH')).not.toBeNull()
    expect(placeOfRegion('Ruhrgebiet, NRW')).not.toBeNull()
    expect(placeOfRegion('Wasatch Front, UT')).not.toBeNull()
  })

  it('accepts any state a region spans', () => {
    for (const hint of ['NY', 'NJ', 'CT'])
      expect(placeOfRegion(`Tri-State Area, ${hint}`)).not.toBeNull()
    expect(placeOfRegion('Lake Tahoe, NV')).toEqual(placeOfRegion('Lake Tahoe, CA'))
    expect(placeOfRegion('Bodensee, AT')).toEqual(placeOfRegion('Bodensee, CH'))
  })

  it('refuses a region whose hint names another state', () => {
    // Houston has a Bay Area too.
    expect(placeOfRegion('Bay Area, TX')).toBeNull()
    expect(placeOfRegion('Tri-State Area, CA')).toBeNull()
    expect(placeOfRegion('Allgäu, AT')).toBeNull()
  })

  it('leaves towns to the gazetteer', () => {
    expect(placeOfRegion('Boulder, CO')).toBeNull()
    expect(placeOfRegion('Innsbruck, AT')).toBeNull()
    expect(placeOfRegion('')).toBeNull()
  })
})

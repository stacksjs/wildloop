import { describe, expect, it } from 'bun:test'
import { agrees, parkOf, placeOfRegion, placeOfText, regionNear, searchPlaces } from '../../app/Support/placeText'

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

/**
 * The places a trail photo search by name is narrowed by (#1006): a file
 * titled "Cathedral Rock" is Sedona's when its page says Coconino or Arizona.
 * Rows below are the catalog's own (database/trailbuddy.sqlite).
 */
describe('the places a trail lies in', () => {
  it('names the park by its own name, without its designation', () => {
    expect(parkOf({ managed_by: 'Coconino National Forest' })).toBe('Coconino')
    expect(parkOf({ managed_by: 'Yosemite National Park' })).toBe('Yosemite')
    expect(parkOf({ managed_by: 'Mount Tamalpais State Park' })).toBe('Mount Tamalpais')
    expect(parkOf({ managed_by: 'Golden Gate National Recreation Area' })).toBe('Golden Gate')
    expect(parkOf({ managed_by: 'Columbia River Gorge National Scenic Area' })).toBe('Columbia River Gorge')
    expect(parkOf({ managed_by: 'Nationalpark Berchtesgaden' })).toBe('Berchtesgaden')
  })

  it('reads the park from the location when nobody is said to manage it', () => {
    expect(parkOf({ managed_by: '', location: 'Santa Monica Mountains National Recreation Area, CA' })).toBe('Santa Monica Mountains')
    expect(parkOf({ location: 'Coconino National Forest, AZ' })).toBe('Coconino')
  })

  it('names no park for a town, a trust, or a designation alone', () => {
    expect(parkOf({ managed_by: 'Mountains to Sound Greenway Trust', location: 'North Bend, WA' })).toBeNull()
    expect(parkOf({ location: 'Park City, UT' })).toBeNull()
    expect(parkOf({ managed_by: 'State Park' })).toBeNull()
    expect(parkOf({})).toBeNull()
  })

  it('finds the named region a point lies in, and none far from all of them', () => {
    // Emerald Bay, on Lake Tahoe's west shore.
    expect(regionNear({ lat: 38.9541, lng: -120.1100 })).toBe('lake tahoe')
    // Feldberg, in the Black Forest.
    expect(regionNear({ lat: 47.8740, lng: 8.0040 })).toBe('schwarzwald')
    // Washington's DMV is spelt out: "dmv" alone searches for motor vehicles.
    expect(regionNear({ lat: 38.9, lng: -77.03 })).toBe('dc metro')
    // Sedona is in none of them.
    expect(regionNear({ lat: 34.8256, lng: -111.7880 })).toBeNull()
    expect(regionNear(null)).toBeNull()
  })

  it('lists park, region and state, most specific first, each once', () => {
    expect(searchPlaces({ latitude: 34.8256, longitude: -111.7880, managed_by: 'Coconino National Forest', location: 'Sedona, AZ', state_name: 'Arizona' }))
      .toEqual(['Coconino', 'Arizona'])
    expect(searchPlaces({ latitude: 38.9541, longitude: -120.1100, managed_by: 'Lake Tahoe Basin Management Unit', state_name: 'California' }))
      .toEqual(['lake tahoe', 'California'])
    expect(searchPlaces({ latitude: 34.8256, longitude: -111.7880, state_name: '' })).toEqual([])
  })
})

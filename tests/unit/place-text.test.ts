import { describe, expect, it } from 'bun:test'
import { agrees } from '../../app/Support/placeText'

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

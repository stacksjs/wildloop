import { describe, expect, it } from 'bun:test'
import { visitorLabel } from '../../app/Support/visitorPlace'

/**
 * The place name the catalog shows for "near me".
 *
 * The CDN reports a subdivision as an ISO code, and only some countries use
 * letters. Production served `Lapu-Lapu City, 07` to a visitor in the
 * Philippines — a real city beside a number, which reads as the page being
 * broken rather than as a region (#1005).
 */

describe('visitorLabel', () => {
  it('keeps a subdivision that reads as a place', () => {
    expect(visitorLabel('San Francisco', 'California', 'US')).toBe('San Francisco, California')
  })

  /*
   * The defect. A number is not a place to anybody, so the country goes in its
   * stead — "Lapu-Lapu City, PH" is at least true and legible.
   */
  it('drops a numeric subdivision in favour of the country', () => {
    expect(visitorLabel('Lapu-Lapu City', '07', 'PH')).toBe('Lapu-Lapu City, PH')
  })

  it('falls back to the country when there is no subdivision at all', () => {
    expect(visitorLabel('Vienna', null, 'AT')).toBe('Vienna, AT')
    expect(visitorLabel('Vienna', '', 'AT')).toBe('Vienna, AT')
  })

  it('uses whatever names the place when the city is unknown', () => {
    // A named region identifies a place on its own, so it does not need the
    // country after it — which is also what the label did before this change.
    expect(visitorLabel(null, 'Bayern', 'DE')).toBe('Bayern')
    // A numeric one names nothing, so the country is all that is left.
    expect(visitorLabel(null, '07', 'PH')).toBe('PH')
    expect(visitorLabel(null, null, 'DE')).toBe('DE')
  })

  it('returns nothing rather than an empty string when it knows nothing', () => {
    expect(visitorLabel(null, null, null)).toBeNull()
    expect(visitorLabel('', '', '')).toBeNull()
  })

  /*
   * A city-state reports the same name twice. "Singapore, Singapore" is not
   * wrong so much as silly.
   */
  it('does not repeat a name that is both city and country', () => {
    expect(visitorLabel('Singapore', null, 'Singapore')).toBe('Singapore')
  })

  it('trims whatever the CDN sent', () => {
    expect(visitorLabel('  Denver ', ' Colorado ', 'US')).toBe('Denver, Colorado')
  })
})

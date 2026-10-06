import { describe, expect, it } from 'bun:test'
import { exploreNearLinks, forecastBar, forecastDayLabel, placeOfLocation, ratingSummary, trailBreadcrumbs, trailFacts, trailFaq, whereLocation, wholeTrailFigures } from '../../resources/functions/trail-page'

const ROCK_RIDGE = {
  id: 6139,
  name: 'Rock Ridge Trail West',
  location: 'Santa Monica Mountains National Recreation Area, CA',
  distance: 1.46,
  elevation: 0,
  difficulty: 'easy',
  estimatedTime: '29m',
  routeType: 'out-and-back',
  rating: 0,
  reviewCount: 0,
  state: 'CA',
  stateName: 'California',
  country: 'US',
  managedBy: 'Santa Monica Mountains National Recreation Area',
  dogsAllowed: null,
  lat: 34.185,
  lng: -118.78,
}

describe('trailBreadcrumbs', () => {
  it('walks back from the park to the catalog', () => {
    expect(trailBreadcrumbs(ROCK_RIDGE)).toEqual([
      { label: 'Explore', href: '/trails' },
      { label: 'United States', href: '/trails?country=US' },
      { label: 'California', href: '/trails?country=US&state=CA' },
      { label: 'Santa Monica Mountains National Recreation Area', href: '/trails?q=Santa%20Monica%20Mountains%20National%20Recreation%20Area' },
    ])
  })

  it('skips what the catalog does not know', () => {
    expect(trailBreadcrumbs({ id: 1, name: 'X' })).toEqual([{ label: 'Explore', href: '/trails' }])
  })
})

describe('trailFaq', () => {
  const faq = trailFaq(ROCK_RIDGE)
  const questions = faq.map(entry => entry.question)

  it('answers length, difficulty and location from the trail', () => {
    expect(questions).toEqual([
      'How long is Rock Ridge Trail West?',
      'How difficult is Rock Ridge Trail West?',
      'Where is Rock Ridge Trail West?',
    ])
    expect(faq[0].answer).toBe('Rock Ridge Trail West is 1.5 mi, an out-and-back route. Most people take about 29m to complete it.')
    expect(trailFaq({ ...ROCK_RIDGE, routeType: 'loop' })[0].answer).toContain('a loop route')
  })

  it('never claims a climb the source did not record, or a dog rule it does not know', () => {
    expect(faq[1].answer).not.toContain('ft')
    expect(questions.some(q => q.includes('dogs'))).toBe(false)
    expect(questions.some(q => q.includes('think'))).toBe(false)
  })

  it('adds dog, access and rating answers when they are known', () => {
    const more = trailFaq({ ...ROCK_RIDGE, elevation: 1200, dogsAllowed: false, wheelchairAccessible: true, rating: 4.62, reviewCount: 1 })
    expect(more.find(e => e.question.startsWith('How difficult'))?.answer).toContain('1,200 ft')
    expect(more.find(e => e.question.startsWith('Are dogs'))?.answer).toStartWith('No')
    expect(more.find(e => e.question.includes('wheelchair'))).toBeDefined()
    expect(more.find(e => e.question.includes('think'))?.answer).toBe('It is rated 4.6 out of 5 across 1 review on Wildloop.')
  })
})

describe('exploreNearLinks', () => {
  it('links the region with its country, and the trail\'s surroundings', () => {
    const [region, nearby] = exploreNearLinks(ROCK_RIDGE)
    expect(region.title).toBe('In California')
    expect(region.links[1]).toEqual({ label: 'Easy trails in California', href: '/trails?country=US&state=CA&difficulty=easy' })
    expect(nearby.links[0].href).toBe('/trails?near=Santa%20Monica%20Mountains%20National%20Recreation%20Area&lat=34.185&lng=-118.78')
  })
})

describe('a trail near a town rather than in it', () => {
  // A back-country trail named after a town 25-45 km off.
  const KETTLE_CREST = { id: 298439, name: 'Kettle Crest Trail North', location: 'Near Republic, WA', state: 'WA', stateName: 'Washington', country: 'US', lat: 48.833515, lng: -118.417908 }

  it('reads the place without the "Near"', () => {
    expect(placeOfLocation('Near Republic, WA')).toBe('Republic, WA')
    expect(placeOfLocation('Republic, WA')).toBe('Republic, WA')
    expect(placeOfLocation(null)).toBe('')
  })

  it('says near in a sentence, and in where it is', () => {
    expect(whereLocation('Near Republic, WA')).toBe('near Republic, WA')
    expect(whereLocation('Hollywood, CA')).toBe('in Hollywood, CA')
    expect(whereLocation('')).toBe('')
    expect(trailFaq(KETTLE_CREST).find(e => e.question.startsWith('Where'))?.answer).toStartWith('Kettle Crest Trail North is near Republic, WA, Washington.')
  })

  it('links trails near the town, not near "Near Republic"', () => {
    const [, nearby] = exploreNearLinks(KETTLE_CREST)
    expect(nearby.links[0].label).toBe('Trails near Republic')
  })
})

describe('ratingSummary', () => {
  it('averages and buckets valid ratings only', () => {
    const summary = ratingSummary([{ rating: 5 }, { rating: 4 }, { rating: 5 }, { rating: 0 }, {}])
    expect(summary.count).toBe(3)
    expect(summary.average).toBe(4.7)
    expect(summary.bars[0]).toEqual({ stars: 5, count: 2, percent: 67 })
    expect(summary.bars[4]).toEqual({ stars: 1, count: 0, percent: 0 })
    expect(ratingSummary([]).average).toBe(0)
  })
})

describe('forecast helpers', () => {
  it('labels today, then weekdays', () => {
    expect(forecastDayLabel('2026-09-25', 0)).toBe('Today')
    expect(forecastDayLabel('2026-09-26', 1)).toBe('Sat')
  })

  it('places each day on the week\'s scale', () => {
    expect(forecastBar({ low: 60, high: 80 }, 60, 100)).toEqual({ left: 0, width: 50 })
    expect(forecastBar({ low: 90, high: 90 }, 60, 100)).toEqual({ left: 75, width: 4 })
  })
})

describe('the figures a trail page states', () => {
  // Mesa Trail in Boulder: 1.14 miles on its own row, folded from pieces.
  const own = { distance: 1.14, elevation: 300, difficulty: 'easy' }

  it('are the whole trail where it was folded from pieces', () => {
    expect(wholeTrailFigures(own, { distance: 4.2, elevation: 900, difficulty: 'moderate' }))
      .toEqual({ distance: 4.2, elevation: 900, difficulty: 'moderate' })
  })

  it('keep the row climb and grade where the whole ones are not known yet', () => {
    expect(wholeTrailFigures(own, { distance: 4.2, elevation: null, difficulty: null }))
      .toEqual({ distance: 4.2, elevation: 300, difficulty: 'easy' })
  })

  it('are the row own figures for a trail with no pieces', () => {
    expect(wholeTrailFigures(own, null)).toEqual(own)
    expect(wholeTrailFigures(own, undefined)).toEqual(own)
  })

  it('read as a search result reads them, leaving out what is not known', () => {
    expect(trailFacts({ distance: 4.2, elevation: 1234, difficulty: 'moderate' })).toBe('Moderate · 4.2 mi · 1,234 ft elevation gain')
    expect(trailFacts(wholeTrailFigures(own, { distance: 4.2, elevation: null, difficulty: null }))).toBe('Easy · 4.2 mi · 300 ft elevation gain')
    expect(trailFacts({ distance: 0, elevation: 0, difficulty: '' })).toBe('')
    // A grade with no ascent behind it says so: this string is the page's meta
    // description, where there is no elevation row beside it reading "Not
    // recorded" (#1004).
    expect(trailFacts({ distance: 0.4, elevation: 0, difficulty: 'easy' })).toBe('Easy (estimated) · 0.4 mi')
    expect(trailFacts({ distance: 2.67, elevation: 1000, difficulty: 'moderate' })).toBe('Moderate · 2.7 mi · 1,000 ft elevation gain')
    expect(trailFacts({ distance: 14.2 })).toBe('14.2 mi')
  })
})

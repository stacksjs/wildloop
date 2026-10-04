import { describe, expect, it } from 'bun:test'
import {
  engagementAppeal,
  lengthAppeal,
  milesBetween,
  nameAppeal,
  proximityWeight,
  rankTrails,
  ratingAppeal,
  sameTrailKey,
  tasteFit,
  tasteProfile,
} from '../../app/Support/trailRanking'

/**
 * Ranking the trails around somebody.
 *
 * The rows below are real catalog rows from around Santa Monica, where the
 * old order — the longest routes in a 50-mile box — opened on Upper Pacoima
 * Canyon, 25 miles away, and left Temescal Canyon off the first screen.
 */

const SANTA_MONICA = { lat: 34.0268, lng: -118.4733 }

let nextId = 1
function trail(name: string, lat: number, lng: number, extra: Record<string, unknown> = {}) {
  return {
    id: nextId++,
    name,
    location: 'Santa Monica Mountains National Recreation Area, CA',
    source: 'nps',
    distance: 2,
    rating: 0,
    review_count: 0,
    national_trail: 0,
    latitude: lat,
    longitude: lng,
    ...extra,
  }
}

describe('what a name says', () => {
  it('prefers somewhere people set out for', () => {
    expect(nameAppeal('Escondido Falls Trail')).toBeGreaterThan(nameAppeal('Hastain Trail'))
    expect(nameAppeal('Sandstone Peak Trail')).toBeGreaterThan(nameAppeal('Temescal Canyon Trail'))
    expect(nameAppeal('Temescal Canyon Trail')).toBeGreaterThan(nameAppeal('Hastain Trail'))
  })

  it('demotes the roads that connect trails', () => {
    for (const road of ['Edison Road', 'Castro Motorway', 'Santa Clara Truck Trail', 'Sullivan Ridge Fire Road', 'Arroyo Simi Bikeway', 'Culver Boulevard Median Path'])
      expect(nameAppeal(road), road).toBeLessThan(nameAppeal('Hastain Trail'))
  })

  it('does not mistake a word inside another word for a signal', () => {
    // "Broadway" is not a road, "Peakview" is not a peak, "Trailer" is not a trail.
    expect(nameAppeal('Broadway Trail')).toBe(nameAppeal('Hastain Trail'))
    expect(nameAppeal('Trailer Canyon')).toBe(nameAppeal('Temescal Canyon'))
  })

  it('lets a road to a peak keep some of the peak', () => {
    expect(nameAppeal('Josephine Peak Road')).toBeGreaterThan(nameAppeal('Edison Road'))
    expect(nameAppeal('Josephine Peak Road')).toBeLessThan(nameAppeal('Josephine Peak'))
  })

  it('sends nobody down a trail that is proposed, closed or a test', () => {
    for (const name of ['Proposed COSCA Trail', 'Las Virgenes View Trail test', 'Barley Flats Trail -UNMAINTAINED-', 'Closed Canyon Spur'])
      expect(nameAppeal(name), name).toBeLessThan(0.2)
  })

  it('treats a code or a placeholder as no name at all', () => {
    for (const name of ['4N35', '2N04A', 'Trail 1W03', '#12', 'Unnamed Wilacre', ''])
      expect(nameAppeal(name), name).toBeLessThan(0.5)
  })

  it('reads names outside English', () => {
    expect(nameAppeal('Höhenweg Zürichberg')).toBe(1)
    expect(nameAppeal('Partnachklamm Loop')).toBeGreaterThan(1)
  })
})

describe('length, reviews and use', () => {
  it('peaks at a day hike', () => {
    expect(lengthAppeal(5)).toBeGreaterThan(lengthAppeal(12))
    expect(lengthAppeal(12)).toBeGreaterThan(lengthAppeal(0.6))
    expect(lengthAppeal(0.6)).toBeGreaterThan(lengthAppeal(0.2))
    expect(lengthAppeal(0.2)).toBe(lengthAppeal(400))
  })

  it('costs an unreviewed trail nothing', () => {
    expect(ratingAppeal(0, 0)).toBe(1)
    expect(ratingAppeal(5, 0)).toBe(1)
  })

  it('does not let one five-star review make a five-star trail', () => {
    expect(ratingAppeal(5, 1)).toBeLessThan(ratingAppeal(4.8, 40))
    expect(ratingAppeal(2, 10)).toBeLessThan(1)
  })

  it('grows with use, and slower the more there is', () => {
    expect(engagementAppeal(0)).toBe(1)
    const one = engagementAppeal(0, { saves: 1, completions: 0, photos: 0 })
    const ten = engagementAppeal(0, { saves: 10, completions: 0, photos: 0 })
    const hundred = engagementAppeal(0, { saves: 100, completions: 0, photos: 0 })
    expect(one).toBeGreaterThan(1)
    expect(hundred - ten).toBeLessThan((ten - one) * 2)
    // Walking a trail says more than saving it.
    expect(engagementAppeal(0, { saves: 0, completions: 1, photos: 0 })).toBeGreaterThan(one)
  })
})

describe('distance', () => {
  it('measures miles', () => {
    // Santa Monica Pier to Temescal Canyon trailhead: about four miles.
    expect(milesBetween(SANTA_MONICA, 34.0499, -118.5287)).toBeGreaterThan(3.3)
    expect(milesBetween(SANTA_MONICA, 34.0499, -118.5287)).toBeLessThan(3.8)
  })

  it('halves at a scale that follows the radius', () => {
    expect(proximityWeight(0, 25)).toBe(1)
    expect(proximityWeight(15, 25)).toBeCloseTo(0.5)
    // A search that had to widen to 150 miles is somewhere sparse, where 90
    // miles is local.
    expect(proximityWeight(90, 150)).toBeCloseTo(0.5)
  })
})

describe('ranking a place', () => {
  const temescal = trail('Temescal Canyon Trail', 34.0499, -118.5287, { distance: 1.91 })
  const pacoima = trail('Upper Pacoima Canyon Trail', 34.32, -118.2, { distance: 13.83, source: 'usfs', location: 'Angeles National Forest, CA' })
  const fireRoad = trail('Sullivan Ridge Fire Road', 34.06, -118.49, { distance: 2 })
  const proposed = trail('Proposed COSCA Trail', 34.03, -118.475, { distance: 2.9 })
  const escondido = trail('Escondido Falls Trail', 34.0389, -118.7832, { distance: 1.04 })

  it('opens on the good trail nearby, not the long one far away', () => {
    const ranked = rankTrails([pacoima, fireRoad, proposed, temescal, escondido], SANTA_MONICA, 25)
    expect(ranked[0].trail.name).toBe('Temescal Canyon Trail')
    expect(ranked.at(-1)?.trail.name).toBe('Proposed COSCA Trail')
    expect(ranked.findIndex(r => r.trail === pacoima)).toBeGreaterThan(ranked.findIndex(r => r.trail === fireRoad))
  })

  it('lets a famous trail further out beat a fire road next door', () => {
    // Half an hour up the coast, against a plain fire road a mile from home.
    const casiano = trail('Casiano Fire Road', 34.035, -118.48, { distance: 1.4 })
    const ranked = rankTrails([casiano, escondido], SANTA_MONICA, 25)
    expect(ranked[0].trail.name).toBe('Escondido Falls Trail')
  })

  it('carries how far away each trail is', () => {
    const [first] = rankTrails([temescal], SANTA_MONICA, 25)
    expect(first.milesAway).toBeCloseTo(milesBetween(SANTA_MONICA, 34.0499, -118.5287))
  })

  it('lets what people actually do outrank what a name suggests', () => {
    const quiet = trail('Hastain Trail', 34.06, -118.5, { distance: 2.5 })
    const loved = trail('Garapito Trail', 34.06, -118.5, { distance: 2.5 })
    const activity = new Map([[loved.id, { saves: 30, completions: 20, photos: 5 }]])
    expect(rankTrails([quiet, loved], SANTA_MONICA, 25, 'best', activity)[0].trail).toBe(loved)
    expect(rankTrails([escondido, loved], SANTA_MONICA, 25, 'popular', activity)[0].trail).toBe(loved)
  })

  it('puts reviewed trails first under top rated, and best match after them', () => {
    const reviewed = trail('Hastain Trail', 34.06, -118.5, { rating: 4.6, review_count: 12 })
    const ranked = rankTrails([temescal, reviewed, escondido], SANTA_MONICA, 25, 'rating')
    expect(ranked.map(r => r.trail.name)).toEqual(['Hastain Trail', 'Temescal Canyon Trail', 'Escondido Falls Trail'])
  })

  it('orders closest by distance, with junk behind every real trail', () => {
    const ranked = rankTrails([escondido, proposed, temescal, fireRoad], SANTA_MONICA, 25, 'nearest')
    expect(ranked.map(r => r.trail.name)).toEqual([
      'Sullivan Ridge Fire Road',
      'Temescal Canyon Trail',
      'Escondido Falls Trail',
      'Proposed COSCA Trail',
    ])
  })

  it('skips a row that cannot be placed', () => {
    const nowhere = trail('Nowhere Trail', Number.NaN, Number.NaN)
    expect(rankTrails([nowhere, temescal], SANTA_MONICA, 25).map(r => r.trail.name)).toEqual(['Temescal Canyon Trail'])
  })

  it('breaks ties on id, so two pages agree', () => {
    const a = trail('Hastain Trail', 34.06, -118.5)
    const b = trail('Musch Trail', 34.06, -118.5)
    expect(rankTrails([b, a], SANTA_MONICA, 25).map(r => r.trail.id)).toEqual([a.id, b.id])
  })
})

describe('one trail, one row', () => {
  it('keys a trail by its name, not its punctuation or notes', () => {
    expect(sameTrailKey('Eagle Rock Fire Road (Backbone Trail)')).toBe(sameTrailKey('eagle rock fire road'))
    expect(sameTrailKey('Sam Merrill Trail')).toBe(sameTrailKey('Sam Merrill'))
    expect(sameTrailKey('Zürichberg-Weg')).toBe(sameTrailKey('Zurichberg Weg'))
    expect(sameTrailKey('Red Trail')).not.toBe(sameTrailKey('Red Loop'))
  })

  it('folds pieces of one trail into its best piece, whatever the sort', () => {
    // Condor Peak Trail arrives from the Forest Service and from OpenStreetMap,
    // half a mile apart; Rivas Canyon as the park's 2-mile trail and a
    // 0.4-mile way.
    const rivas = trail('Rivas Canyon Trail', 34.059, -118.507, { distance: 2.07 })
    const rivasStub = trail('Rivas Canyon Trail', 34.055, -118.505, { distance: 0.43, source: 'osm', location: 'California' })

    for (const mode of ['best', 'nearest', 'popular', 'rating'] as const) {
      const ranked = rankTrails([rivasStub, rivas], SANTA_MONICA, 25, mode)
      expect(ranked, mode).toHaveLength(1)
      expect(ranked[0].trail, mode).toBe(rivas)
    }
  })

  it('keeps two trails that only share a name', () => {
    const here = trail('Red Trail', 34.06, -118.5)
    const there = trail('Red Trail', 34.2, -118.2)
    expect(rankTrails([here, there], SANTA_MONICA, 25)).toHaveLength(2)
  })
})

describe('trails you may like', () => {
  // Somebody who does 5- to 7-mile moderate loops.
  const done = [
    { distance: 5.2, difficulty: 'moderate', route_type: 'loop' },
    { distance: 6.1, difficulty: 'moderate', route_type: 'loop' },
    { distance: 7.0, difficulty: 'hard', route_type: 'loop' },
    { distance: 5.8, difficulty: 'moderate', route_type: 'out-and-back' },
  ]

  it('reads a taste from a few trails, and refuses to from one', () => {
    const taste = tasteProfile(done)
    expect(taste?.medianMiles).toBeCloseTo(5.95)
    expect(taste?.difficulty.moderate).toBeCloseTo(0.75)
    expect(taste?.loopShare).toBeCloseTo(0.75)
    expect(tasteProfile(done.slice(0, 1))).toBeNull()
    expect(tasteProfile([])).toBeNull()
  })

  it('fits the kind of trail somebody already does', () => {
    const taste = tasteProfile(done)
    const like = { id: 1, distance: 6, difficulty: 'moderate', route_type: 'loop' }
    const shortEasy = { id: 2, distance: 1.2, difficulty: 'easy', route_type: 'out-and-back' }
    expect(tasteFit(like, taste)).toBeGreaterThan(1)
    expect(tasteFit(shortEasy, taste)).toBeLessThan(0.5)
  })

  it('discounts the unfamiliar without ruling it out', () => {
    const taste = tasteProfile(done)
    const easy = tasteFit({ id: 1, distance: 6, difficulty: 'easy', route_type: 'loop' }, taste)
    expect(easy).toBeGreaterThan(0)
    expect(easy).toBeLessThan(tasteFit({ id: 2, distance: 6, difficulty: 'moderate', route_type: 'loop' }, taste))
  })

  it('is best match for somebody with no taste yet', () => {
    expect(tasteFit({ id: 1, distance: 1, difficulty: 'easy' }, null)).toBe(1)
    const a = trail('Hastain Trail', 34.06, -118.5, { distance: 1.2, difficulty: 'easy' })
    const b = trail('Temescal Ridge Trail', 34.06, -118.5, { distance: 5.4, difficulty: 'moderate' })
    expect(rankTrails([a, b], SANTA_MONICA, 25, 'recommended').map(r => r.trail.id))
      .toEqual(rankTrails([a, b], SANTA_MONICA, 25, 'best').map(r => r.trail.id))
  })

  it('steers the list toward that taste', () => {
    const taste = tasteProfile(done)
    // Best match prefers the short canyon walk; somebody who does six-mile
    // moderate loops is shown the ridge first.
    const canyon = trail('Rustic Canyon Trail', 34.06, -118.5, { distance: 2.5, difficulty: 'easy', route_type: 'out-and-back' })
    const ridge = trail('Garapito Ridge Loop', 34.08, -118.55, { distance: 6.3, difficulty: 'moderate', route_type: 'loop', source: 'osm', location: 'California' })
    expect(rankTrails([canyon, ridge], SANTA_MONICA, 25, 'best')[0].trail).toBe(canyon)
    expect(rankTrails([canyon, ridge], SANTA_MONICA, 25, 'recommended', new Map(), taste)[0].trail).toBe(ridge)
  })
})

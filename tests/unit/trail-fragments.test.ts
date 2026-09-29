import type { FragmentCandidate } from '../../app/Support/trailFragments'
import { describe, expect, it } from 'bun:test'
import { fragmentClusters, groupKey, normalizeName, summarise } from '../../app/Support/trailFragments'

/**
 * Deciding which catalog rows are pieces of one trail.
 *
 * Every case here is one where merging on the obvious rule hands back a
 * plausible answer that is wrong — and wrong by destroying a real trail, which
 * no amount of re-running the import brings back. So the tests that matter are
 * the ones where rows share a name and must NOT be joined.
 */

/** A straight line of `points` coordinates heading north from (lat, lng). */
function line(lat: number, lng: number, points = 4, stepDegrees = 0.002): { lat: number, lng: number }[] {
  return Array.from({ length: points }, (_, i) => ({ lat: lat + i * stepDegrees, lng }))
}

let nextId = 1
function trail(name: string, geometry: { lat: number, lng: number }[], extra: Partial<FragmentCandidate> = {}): FragmentCandidate {
  return { id: nextId++, name, country: 'US', distance: 1, geometry, ...extra }
}

describe('normalizeName', () => {
  it('treats case and spacing as noise from the source', () => {
    expect(normalizeName('  Red   Trail ')).toBe('red trail')
    expect(normalizeName('RED TRAIL')).toBe(normalizeName('red trail'))
  })

  /*
   * Deliberately not clever.
   *
   * Stripping words like "Loop" or "Spur" would merge "Red Trail" with "Red
   * Trail Loop", which are two trails that meet at a junction. A name that
   * differs at all is a different name.
   */
  it('keeps names that merely resemble each other apart', () => {
    expect(normalizeName('Red Trail')).not.toBe(normalizeName('Red Trail Loop'))
    expect(normalizeName('Red Trail')).not.toBe(normalizeName('Red Trails'))
  })
})

describe('groupKey', () => {
  it('separates the same name in two countries', () => {
    const a = { id: 1, name: 'Schillingsweg', country: 'DE', geometry: [] }
    const b = { id: 2, name: 'Schillingsweg', country: 'AT', geometry: [] }
    expect(groupKey(a)).not.toBe(groupKey(b))
  })

  it('does not confuse a name ending where a country begins', () => {
    // Joined on a NUL rather than a dash, so "a" + "b-c" cannot collide with
    // "a-b" + "c".
    expect(groupKey({ id: 1, name: 'north', country: 'us-west', geometry: [] }))
      .not.toBe(groupKey({ id: 2, name: 'north-us', country: 'west', geometry: [] }))
  })
})

describe('fragmentClusters', () => {
  /*
   * The case the whole file exists for.
   *
   * A production sample holds six "Red Trail" rows and six "Link Trail" rows
   * ranging from 0.12 to 35.87 miles. They are not one trail — they are the
   * red-blazed trail in six different parks. Merging by name would delete five
   * real trails and report it as a tidy-up.
   */
  it('refuses to join two trails that only share a name', () => {
    nextId = 1
    const parkA = trail('Red Trail', line(40.0, -105.0))
    const parkB = trail('Red Trail', line(44.5, -110.5)) // several hundred miles away

    expect(fragmentClusters([parkA, parkB])).toEqual([])
  })

  it('joins pieces that actually touch', () => {
    nextId = 1
    // Two runs meeting end to start: 40.000-40.006, then 40.006-40.012.
    const lower = trail('Ridge Trail', line(40.0, -105.0))
    const upper = trail('Ridge Trail', line(40.006, -105.0))

    const clusters = fragmentClusters([lower, upper])
    expect(clusters).toHaveLength(1)
    expect(clusters[0].members.map(m => m.id).sort()).toEqual([lower.id, upper.id])
  })

  /*
   * The real shape from production: one trail arriving as many pieces.
   *
   * "Continental Divide NST" is six rows measuring 2.67 to 42.44 miles. They
   * are consecutive, so they chain.
   */
  it('gathers a long trail that arrived in pieces', () => {
    nextId = 1
    const pieces = Array.from({ length: 6 }, (_, i) =>
      trail('Continental Divide NST', line(39.0 + i * 0.006, -106.0), { distance: 5 }))

    const clusters = fragmentClusters(pieces)
    expect(clusters).toHaveLength(1)
    expect(clusters[0].members).toHaveLength(6)
    expect(clusters[0].totalDistance).toBe(30)
  })

  it('splits one name into the separate trails it actually is', () => {
    nextId = 1
    const here = [trail('Link Trail', line(40.0, -105.0)), trail('Link Trail', line(40.006, -105.0))]
    const away = [trail('Link Trail', line(47.0, -120.0)), trail('Link Trail', line(47.006, -120.0))]

    const clusters = fragmentClusters([...here, ...away])
    // Two trails, each assembled from its own two pieces — not one of four.
    expect(clusters).toHaveLength(2)
    for (const cluster of clusters) expect(cluster.members).toHaveLength(2)
  })

  it('leaves a trail that is already whole alone', () => {
    nextId = 1
    expect(fragmentClusters([trail('Angels Landing', line(37.2, -112.9))])).toEqual([])
  })

  /*
   * A row with no line cannot be placed, so there is no evidence it belongs to
   * anything. Falling back to the name for these is the over-merge by another
   * route.
   */
  it('will not merge a row it cannot place', () => {
    nextId = 1
    const placed = trail('Ridge Trail', line(40.0, -105.0))
    const unplaced = trail('Ridge Trail', [])

    const clusters = fragmentClusters([placed, unplaced])
    expect(clusters).toEqual([])
  })

  it('ignores a row with no name', () => {
    nextId = 1
    expect(fragmentClusters([trail('   ', line(40.0, -105.0)), trail('   ', line(40.006, -105.0))])).toEqual([])
  })

  describe('the row the others fold into', () => {
    it('is the longest, as the one most likely to be the whole route', () => {
      nextId = 1
      const spur = trail('Ridge Trail', line(40.0, -105.0), { distance: 0.4 })
      const whole = trail('Ridge Trail', line(40.006, -105.0), { distance: 12 })

      const [cluster] = fragmentClusters([spur, whole])
      expect(cluster.canonical.id).toBe(whole.id)
      // Canonical first, so a caller can take members[0] without re-sorting.
      expect(cluster.members[0].id).toBe(whole.id)
    })

    it('is the same row every run, so a merge can be repeated', () => {
      nextId = 1
      const a = trail('Ridge Trail', line(40.0, -105.0), { distance: 5 })
      const b = trail('Ridge Trail', line(40.006, -105.0), { distance: 5 })

      const first = fragmentClusters([a, b])[0].canonical.id
      const second = fragmentClusters([b, a])[0].canonical.id
      expect(second).toBe(first)
    })
  })
})

describe('summarise', () => {
  it('counts what a run would take out of the catalog', () => {
    nextId = 1
    const clusters = fragmentClusters([
      trail('Ridge Trail', line(40.0, -105.0)),
      trail('Ridge Trail', line(40.006, -105.0)),
      trail('Ridge Trail', line(40.012, -105.0)),
      trail('Creek Trail', line(41.0, -105.0)),
      trail('Creek Trail', line(41.006, -105.0)),
    ])

    // Five rows become two trails: three absorbed, two left standing.
    expect(summarise(clusters)).toEqual({ clusters: 2, absorbed: 3, canonical: 2 })
  })

  it('counts nothing when there is nothing to merge', () => {
    expect(summarise([])).toEqual({ clusters: 0, absorbed: 0, canonical: 0 })
  })
})

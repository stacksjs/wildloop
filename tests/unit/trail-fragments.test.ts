import type { FragmentCandidate } from '../../app/Support/trailFragments'
import { describe, expect, it } from 'bun:test'
import { clusterRuns } from '../../app/Ingest/sources/arcgis'
import { compareCanonical, FOLD_RADIUS_MILES, foldPieces, fragmentClusters, groupKey, isPinned, normalizeName, summarise } from '../../app/Support/trailFragments'

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

    /*
     * The Park Service draws and names the trails it manages; an OSM way is a
     * stretch between two junctions, and can be longer only because it runs
     * on past where the park's trail ends.
     */
    it('is the park\'s own record over a longer OpenStreetMap way', () => {
      nextId = 1
      const way = trail('Ridge Trail', line(40.0, -105.0), { distance: 6, source: 'osm' })
      const park = trail('Ridge Trail', line(40.006, -105.0), { distance: 4, source: 'nps' })

      expect(fragmentClusters([way, park])[0].canonical.id).toBe(park.id)
    })

    it('is the one people reviewed, between two otherwise alike', () => {
      nextId = 1
      const plain = trail('Ridge Trail', line(40.0, -105.0), { distance: 2 })
      const reviewed = trail('Ridge Trail', line(40.006, -105.0), { distance: 2, reviewCount: 2 })

      expect(fragmentClusters([plain, reviewed])[0].canonical.id).toBe(reviewed.id)
      expect(compareCanonical(reviewed, plain)).toBeLessThan(0)
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

describe('isPinned', () => {
  it('pins what people made and what was typed in by hand, and nothing else', () => {
    nextId = 1
    expect(isPinned(trail('A Trail', line(40, -105), { reviewCount: 1 }))).toBe(true)
    expect(isPinned(trail('A Trail', line(40, -105), { photos: 3 }))).toBe(true)
    expect(isPinned(trail('A Trail', line(40, -105), { source: 'manual' }))).toBe(true)
    expect(isPinned(trail('A Trail', line(40, -105), { source: 'nps', distance: 40 }))).toBe(false)
  })
})

/** A straight run north from (lat, lng) about `miles` long, in two points. */
function stretch(lat: number, lng: number, miles: number): { lat: number, lng: number }[] {
  return [{ lat, lng }, { lat: lat + miles / 69, lng }]
}

describe('foldPieces', () => {
  it('folds the short pieces of a trail into the whole of it', () => {
    nextId = 1
    const whole = trail('Mesa Trail', stretch(40.0, -105.25, 2), { distance: 2 })
    const below = trail('Mesa Trail', stretch(40.0 - 0.4 / 69, -105.25, 0.4), { distance: 0.4 })
    const above = trail('Mesa Trail', stretch(40.0 + 2 / 69, -105.25, 0.3), { distance: 0.3 })

    const folds = foldPieces([below, whole, above])
    expect([...folds.entries()].sort()).toEqual([[below.id, whole.id], [above.id, whole.id]])
  })

  /*
   * The rule that matters most, at the level that writes. Each of these is a
   * plausible merge by name, and each would hide a real trail.
   */
  describe('never folds two trails that only share a name', () => {
    it('in different parks', () => {
      nextId = 1
      const boulder = [trail('Red Trail', stretch(40.0, -105.25, 0.3)), trail('Red Trail', stretch(40.0 + 0.3 / 69, -105.25, 0.3))]
      const bend = [trail('Red Trail', stretch(44.0, -121.3, 0.3)), trail('Red Trail', stretch(44.0 + 0.3 / 69, -121.3, 0.3))]

      const folds = foldPieces([boulder[0], bend[0], boulder[1], bend[1]])
      // Each park's two pieces become one trail; no piece crosses parks.
      expect(folds.size).toBe(2)
      for (const [piece, partOf] of folds) {
        const sameSide = boulder.some(t => t.id === piece) === boulder.some(t => t.id === partOf)
        expect(sameSide).toBe(true)
      }
    })

    it('a stone\'s throw apart but not touching', () => {
      nextId = 1
      // Two "Loop Trail"s in neighbouring parks, ends 2 km apart.
      const a = trail('Loop Trail', stretch(40.0, -105.0, 1))
      const b = trail('Loop Trail', stretch(40.0 + 1 / 69 + 0.018, -105.0, 1))

      expect(foldPieces([a, b]).size).toBe(0)
    })

    it('either side of a border, even where the lines meet', () => {
      nextId = 1
      const german = trail('Grenzweg', stretch(47.5, 11.0, 0.5), { country: 'DE' })
      const austrian = trail('Grenzweg', stretch(47.5 + 0.5 / 69, 11.0, 0.5), { country: 'AT' })

      expect(foldPieces([german, austrian]).size).toBe(0)
    })

    it('with no line to place them by', () => {
      nextId = 1
      expect(foldPieces([trail('Ridge Trail', stretch(40, -105, 1)), trail('Ridge Trail', [])]).size).toBe(0)
    })
  })

  it('never folds a row people reviewed or photographed, or one typed in by hand', () => {
    nextId = 1
    const whole = trail('Mesa Trail', stretch(40.0, -105.25, 2), { distance: 2, source: 'nps' })
    const reviewed = trail('Mesa Trail', stretch(40.0 + 2 / 69, -105.25, 0.3), { distance: 0.3, reviewCount: 1 })
    const photographed = trail('Mesa Trail', stretch(40.0 + 2.3 / 69, -105.25, 0.3), { distance: 0.3, photos: 1 })
    const manual = trail('Mesa Trail', stretch(40.0 - 0.3 / 69, -105.25, 0.3), { distance: 0.3, source: 'manual' })
    const plain = trail('Mesa Trail', stretch(40.0 - 0.6 / 69, -105.25, 0.3), { distance: 0.3 })

    const folds = foldPieces([whole, reviewed, photographed, manual, plain])
    // The pinned rows stay listed beside the park's trail, and the plain
    // piece folds into the park's trail.
    expect([...folds.entries()]).toEqual([[plain.id, whole.id]])
  })

  /*
   * Near me finds a trail by where it starts. Folding the fourth five-mile
   * section of a long trail into the first would take the trail off the list
   * of somebody standing at the fourth.
   */
  it(`keeps a long trail's stretches more than ${FOLD_RADIUS_MILES} miles apart, and folds the pieces around them`, () => {
    nextId = 1
    const stretches = Array.from({ length: 4 }, (_, i) => trail('Colorado Trail', stretch(39.0 + (i * 5) / 69, -105.5, 5), { distance: 5 }))
    const stub = trail('Colorado Trail', stretch(39.0 - 0.3 / 69, -105.5, 0.3), { distance: 0.3 })

    const folds = foldPieces([...stretches, stub])
    expect([...folds.entries()]).toEqual([[stub.id, stretches[0].id]])
    expect(fragmentClusters([...stretches, stub])[0].members).toHaveLength(5)
  })

  it('points every piece at a listed row, never at another piece', () => {
    nextId = 1
    const pieces = Array.from({ length: 12 }, (_, i) => trail('Connector Trail', stretch(40.0 + (i * 0.3) / 69, -105.0, 0.3), { distance: 0.3 + (i % 3) * 0.01 }))

    const folds = foldPieces(pieces)
    expect(folds.size).toBeGreaterThan(0)
    for (const partOf of folds.values()) expect(folds.has(partOf)).toBe(false)
  })

  it('decides the same whatever order the rows arrive in', () => {
    nextId = 1
    const rows = Array.from({ length: 8 }, (_, i) => trail('Ridge Trail', stretch(40.0 + (i * 0.4) / 69, -105.0, 0.4), { distance: 0.4 }))

    const forward = [...foldPieces(rows).entries()].sort()
    const backward = [...foldPieces([...rows].reverse()).entries()].sort()
    expect(backward).toEqual(forward)
  })
})

/*
 * Before clustering, rows are split into the sets whose endpoints could ever
 * meet, so a common name is not compared with itself across a whole country.
 * That is only safe if it never changes the answer: checked here against
 * `clusterRuns` comparing every row, on a name as common as "Waldweg".
 */
describe('a common name', () => {
  it('clusters exactly as comparing every row does', () => {
    nextId = 1
    let seed = 7
    const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const rows: FragmentCandidate[] = []
    for (let chain = 0; chain < 40; chain++) {
      // Chains scattered over a few kilometres, so some pass close by others.
      let lat = 47.4 + random() * 0.08
      let lng = 11.0 + random() * 0.08
      for (let piece = 0; piece < 1 + Math.floor(random() * 5); piece++) {
        const next = { lat: lat + (random() - 0.5) * 0.006, lng: lng + (random() - 0.5) * 0.006 }
        rows.push(trail('Waldweg', [{ lat, lng }, next], { country: 'DE', distance: 0.3 }))
        lat = next.lat
        lng = next.lng
      }
    }

    const sets = (clusters: number[][]) => clusters.map(ids => [...ids].sort((a, b) => a - b).join(',')).sort()
    const everyRow = clusterRuns(rows.map(member => ({ run: member.geometry, member })))
      .filter(cluster => cluster.members.length > 1)
      .map(cluster => cluster.members.map(member => member.id))
    const split = fragmentClusters(rows).map(cluster => cluster.members.map(member => member.id))

    expect(everyRow.length).toBeGreaterThan(5)
    expect(sets(split)).toEqual(sets(everyRow))
  })
})

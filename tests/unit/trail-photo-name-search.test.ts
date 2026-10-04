import type { NameSearchTrail } from '../../app/Support/trailPhotoNameSearch'
import { describe, expect, it } from 'bun:test'
import {
  candidatesFromNameSearch,
  commonsNameSearchUrl,
  metresFromTrail,
  NAME_SEARCH_RADIUS_METRES,
  nameSearchPlan,
  searchName,
} from '../../app/Support/trailPhotoNameSearch'

/**
 * Searching Commons by a trail's name (#1006).
 *
 * The search is generous — `intitle:"Cathedral Rock"` brings back the Rock
 * of Cashel's cathedral in Ireland and the Cathedral Rock in Oregon along
 * with Sedona's — so what matters here is what is refused afterwards: a
 * located file too far from the trail, and an unlocated one that names none
 * of the trail's places.
 */

const cathedralRock: NameSearchTrail = {
  name: 'Cathedral Rock Trail',
  latitude: 34.8256,
  longitude: -111.7880,
  location: 'Sedona, AZ',
  managed_by: 'Coconino National Forest',
  state_name: 'Arizona',
}

describe('searchName', () => {
  it.each([
    ['Cathedral Rock Trail', 'Cathedral Rock'],
    ['Jenny Lake Loop', 'Jenny Lake'],
    ['Rattlesnake Ledge', 'Rattlesnake Ledge'],
    // "Mist" alone is weather.
    ['Mist Trail', 'Mist Trail'],
    ['Half Dome via the Mist Trail', 'Half Dome'],
    ['Mist Trail to Vernal Fall', 'Mist Trail'],
    ['Matt Davis – Steep Ravine Loop', 'Matt Davis'],
    ['Bright Angel Trail to Three-Mile Resthouse', 'Bright Angel'],
  ])('searches %s as "%s"', (name, phrase) => {
    expect(searchName(name)).toBe(phrase)
  })

  /*
   * One word, or nothing but generic ones, would bring back every one in the
   * world. Those trails are left to the geosearch.
   */
  it('does not search a name too plain to mean one place', () => {
    for (const name of ['Equestrian', 'walkway', 'The Narrows', 'Loop Trail', 'The Loop Trail', '', 'Trail Trail Trail'])
      expect(searchName(name), name).toBe('')
  })
})

describe('nameSearchPlan and its URL', () => {
  it('narrows the name by the park, then the state', () => {
    expect(nameSearchPlan(cathedralRock)).toEqual({ phrase: 'Cathedral Rock', places: ['Coconino', 'Arizona'] })
  })

  it('asks for pictures titled with the phrase, mentioning any of the places, with every coordinate', () => {
    const url = new URL(commonsNameSearchUrl({ phrase: 'Cathedral Rock', places: ['Coconino', 'Red Rock Country', 'Arizona'] }))
    expect(url.searchParams.get('gsrsearch')).toBe('intitle:"Cathedral Rock" Coconino OR "Red Rock Country" OR Arizona filetype:bitmap')
    expect(url.searchParams.get('generator')).toBe('search')
    // Namespace 6 is File:.
    expect(url.searchParams.get('gsrnamespace')).toBe('6')
    expect(url.searchParams.get('prop')).toBe('imageinfo|coordinates')
    expect(url.searchParams.get('coprimary')).toBe('all')
    expect(url.searchParams.get('iiextmetadatafilter')).toContain('LicenseShortName')
    expect(url.searchParams.get('iiextmetadatafilter')).toContain('Artist')
  })

  it('searches the name alone when no place is known', () => {
    const url = new URL(commonsNameSearchUrl({ phrase: 'Cathedral Rock', places: [] }))
    expect(url.searchParams.get('gsrsearch')).toBe('intitle:"Cathedral Rock" filetype:bitmap')
  })

  it('has no plan for a trail its name cannot find', () => {
    expect(nameSearchPlan({ ...cathedralRock, name: 'Loop Trail' })).toBeNull()
  })
})

describe('metresFromTrail', () => {
  it('measures to the trail head when there is no line', () => {
    expect(metresFromTrail({ lat: 34.8256, lng: -111.7880 }, cathedralRock)).toBeLessThan(1)
    const km = metresFromTrail({ lat: 34.8346, lng: -111.7880 }, cathedralRock) / 1000
    expect(km).toBeGreaterThan(0.95)
    expect(km).toBeLessThan(1.05)
  })

  it('measures to the box the line fills, nothing inside it', () => {
    const lined = { ...cathedralRock, min_lat: 34.82, max_lat: 34.84, min_lng: -111.80, max_lng: -111.78 }
    expect(metresFromTrail({ lat: 34.83, lng: -111.79 }, lined)).toBe(0)
    // A summit 2 km past the head along the line is on the trail, not 2 km off it.
    expect(metresFromTrail({ lat: 34.8399, lng: -111.7801 }, lined)).toBe(0)
    expect(metresFromTrail({ lat: 34.85, lng: -111.79 }, lined)).toBeGreaterThan(1000)
  })
})

describe('candidatesFromNameSearch', () => {
  /** One file as Commons' search answers it, with optional coordinates. */
  const file = (title: string, options: { coords?: Array<[number, number]>, gps?: [string, string], license?: string, description?: string, categories?: string, artist?: string } = {}) => ({
    title: `File:${title}`,
    ...(options.coords ? { coordinates: options.coords.map(([lat, lon], index) => ({ lat, lon, globe: 'earth', ...(index === 0 ? { primary: '' } : {}) })) } : {}),
    imageinfo: [{
      thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/${encodeURIComponent(title)}/960px-${encodeURIComponent(title)}`,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(title)}`,
      extmetadata: {
        ObjectName: { value: title.replace(/\.\w+$/, '') },
        ...(options.license === '' ? {} : { LicenseShortName: { value: options.license ?? 'CC BY-SA 4.0' } }),
        LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' },
        Artist: { value: options.artist ?? '<a href="//commons.wikimedia.org/wiki/User:Hiker" title="User:Hiker">Hiker</a>' },
        ...(options.description ? { ImageDescription: { value: options.description } } : {}),
        ...(options.categories ? { Categories: { value: options.categories } } : {}),
        ...(options.gps ? { GPSLatitude: { value: options.gps[0] }, GPSLongitude: { value: options.gps[1] } } : {}),
      },
    }],
  })
  const payload = (...pages: unknown[]) => ({ query: { pages: Object.fromEntries(pages.map((page, i) => [String(1000 + i), page])) } })
  const titles = (found: Array<{ title: string }>) => found.map(c => c.title)

  it('keeps a located file near the trail and refuses one far from it', () => {
    const found = candidatesFromNameSearch(payload(
      file('Cathedral Rock saddle.jpg', { coords: [[34.8200, -111.7930]] }),
      // Real Commons answers for intitle:"Cathedral Rock": Oregon, and Cashel.
      file('Cathedral Rock (Oregon).jpg', { coords: [[45.3390, -121.7090]] }),
      file('Cashel Cathedral, Rock of Cashel, Caiseal, Éire (31650778787).jpg', { coords: [[52.520013, -7.889996]] }),
    ), cathedralRock)

    expect(titles(found)).toEqual(['Cathedral Rock saddle.jpg'])
    expect(found[0].foundBy).toBe('name')
    expect(found[0].distanceMetres).toBeGreaterThan(500)
    expect(found[0].distanceMetres).toBeLessThan(1500)
    expect(found[0].matched).toEqual(['cathedral', 'rock'])
  })

  /*
   * Where the camera stood is one coordinate; what it shows can be another.
   * A view of the rock from across the valley is still a view of the rock.
   */
  it('keeps a file whose subject is near the trail though the camera was not', () => {
    const found = candidatesFromNameSearch(payload(
      file('Cathedral Rock from Airport Mesa.jpg', { coords: [[34.8530, -111.7880], [34.8240, -111.7870]] }),
    ), cathedralRock)
    expect(found).toHaveLength(1)
    expect(found[0].distanceMetres).toBeLessThan(500)
  })

  it('reads the EXIF position when Commons lists no coordinates', () => {
    const near = candidatesFromNameSearch(payload(file('Cathedral Rock - Sedona AZ-1.jpg', { gps: ['34.820000', '-111.790000'] })), cathedralRock)
    expect(near).toHaveLength(1)
    const far = candidatesFromNameSearch(payload(file('Cathedral Rock AZ-2.jpg', { gps: ['36.0', '-112.1'] })), cathedralRock)
    expect(far).toEqual([])
  })

  it('keeps an unlocated file only when its page names one of the trail\'s places', () => {
    const found = candidatesFromNameSearch(payload(
      file('Cathedral Rock at Red Rock Crossing.jpg', { description: '<p>Seen across Oak Creek, near Sedona, Arizona.</p>' }),
      file('Cathedral Rock, Coconino NF.jpg'),
      file('Cathedral Rock sunrise.jpg', { categories: 'Cathedral Rock (Sedona)|Coconino National Forest' }),
      file('Cathedral Rock in snow.jpg', { description: 'Snow on the buttes', categories: 'Snow' }),
      // "Arizonan" is not Arizona.
      file('Cathedral Rock print.jpg', { description: 'An Arizonan artist\'s print' }),
    ), cathedralRock)

    expect(titles(found)).toEqual([
      'Cathedral Rock at Red Rock Crossing.jpg',
      'Cathedral Rock sunrise.jpg',
      'Cathedral Rock, Coconino NF.jpg',
    ])
    expect(found.every(c => c.distanceMetres === null)).toBe(true)
  })

  /* With no place to check against, a file with no location has no evidence. */
  it('offers only located files when no place is known', () => {
    const nowhere = { ...cathedralRock, managed_by: null, location: null, state_name: null }
    const found = candidatesFromNameSearch(payload(
      file('Cathedral Rock, Sedona, Arizona.jpg'),
      file('Cathedral Rock saddle.jpg', { coords: [[34.8200, -111.7930]] }),
    ), nowhere)
    expect(titles(found)).toEqual(['Cathedral Rock saddle.jpg'])
  })

  it('needs every word of the searched name in the title', () => {
    const found = candidatesFromNameSearch(payload(
      file('Cathedral of Sedona.jpg', { coords: [[34.8250, -111.7880]] }),
      file('Red rocks near Sedona.jpg', { coords: [[34.8250, -111.7880]] }),
      file('Cathedral Rocks at noon.jpg', { coords: [[34.8250, -111.7880]] }),
    ), cathedralRock)
    expect(titles(found)).toEqual(['Cathedral Rocks at noon.jpg'])
  })

  it('carries the licence, and credits the author by name', () => {
    const found = candidatesFromNameSearch(payload(
      file('Cathedral Rock, Sedona.jpg', {
        coords: [[34.8250, -111.7880]],
        artist: '<a href="https://en.wikipedia.org/wiki/User:Chris_Light" class="extiw" title="en:User:Chris Light">Chris Light</a> (<a href="https://en.wikipedia.org/wiki/User_talk:Chris_Light" class="extiw" title="en:User talk:Chris Light">talk</a>)',
      }),
      file('Cathedral Rock, unlicensed.jpg', { coords: [[34.8250, -111.7880]], license: '' }),
    ), cathedralRock)
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ credit: 'Chris Light', license: 'CC BY-SA 4.0', foundBy: 'name' })
    expect(found[0].pageUrl).toContain('commons.wikimedia.org/wiki/File:')
  })

  it('puts the nearest first, then the unlocated', () => {
    const found = candidatesFromNameSearch(payload(
      file('Cathedral Rock, Arizona.jpg'),
      file('Cathedral Rock far.jpg', { coords: [[34.8500, -111.7880]] }),
      file('Cathedral Rock near.jpg', { coords: [[34.8260, -111.7880]] }),
    ), cathedralRock)
    expect(titles(found)).toEqual(['Cathedral Rock near.jpg', 'Cathedral Rock far.jpg', 'Cathedral Rock, Arizona.jpg'])
  })

  it('honours a different radius', () => {
    const answer = payload(file('Cathedral Rock far.jpg', { coords: [[34.8500, -111.7880]] }))
    expect(candidatesFromNameSearch(answer, cathedralRock, undefined, NAME_SEARCH_RADIUS_METRES)).toHaveLength(1)
    expect(candidatesFromNameSearch(answer, cathedralRock, undefined, 1000)).toEqual([])
  })

  it('returns nothing for an empty or broken answer, or a trail it cannot search', () => {
    expect(candidatesFromNameSearch(null, cathedralRock)).toEqual([])
    expect(candidatesFromNameSearch({ query: {} }, cathedralRock)).toEqual([])
    expect(candidatesFromNameSearch(payload(file('Loop Trail.jpg', { coords: [[34.8256, -111.788]] })), { ...cathedralRock, name: 'Loop Trail' })).toEqual([])
  })
})

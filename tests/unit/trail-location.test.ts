import type { ManagedNeighbour, NearbyTown, TrailPlace } from '../../app/Support/trailLocation'
import { describe, expect, it } from 'bun:test'
import { betterLocation, formatTownLocation, managedAreaAround, namesOnlyRegion, townAround } from '../../app/Support/trailLocation'

/**
 * Naming a trail that only knows its state.
 *
 * Coordinates are real: the trails are production rows around Los Angeles and
 * Garmisch-Partenkirchen, the towns come from GeoNames.
 */

const SMMNRA = 'Santa Monica Mountains National Recreation Area, CA'

/** An OSM row as the ingest wrote it: the region, and nothing finer. */
function osm(latitude: number, longitude: number, extra: Partial<TrailPlace> = {}): TrailPlace {
  return {
    location: 'California',
    country: 'US',
    state: 'CA',
    stateName: 'California',
    latitude,
    longitude,
    minLat: latitude - 0.005,
    maxLat: latitude + 0.005,
    minLng: longitude - 0.005,
    maxLng: longitude + 0.005,
    ...extra,
  }
}

function bavarian(latitude: number, longitude: number): TrailPlace {
  return osm(latitude, longitude, { location: 'Bayern', country: 'DE', state: 'DE-BY', stateName: 'Bayern' })
}

/** Agency trails on every side of a point, the nearest `nearKm` away. */
function ring(label: string, lat: number, lng: number, nearKm = 0.5, farKm = 3): ManagedNeighbour[] {
  const deg = (km: number) => km / 111
  return [
    { location: label, latitude: lat + deg(nearKm), longitude: lng + deg(nearKm) },
    { location: label, latitude: lat + deg(farKm), longitude: lng - deg(farKm) },
    { location: label, latitude: lat - deg(farKm), longitude: lng + deg(farKm) },
    { location: label, latitude: lat - deg(farKm), longitude: lng - deg(farKm) },
    { location: label, latitude: lat + deg(2), longitude: lng + deg(1) },
  ]
}

const pacificPalisades: NearbyTown = { name: 'Pacific Palisades', lat: 34.04806, lng: -118.52647, distanceKm: 2.5 }
const hollywood: NearbyTown = { name: 'Hollywood', lat: 34.09834, lng: -118.32674, distanceKm: 0.7 }

describe('which locations are only a region', () => {
  it('is the state name, the state code, or nothing', () => {
    expect(namesOnlyRegion({ location: 'California', state: 'CA', stateName: 'California' })).toBe(true)
    expect(namesOnlyRegion({ location: ' california ', state: 'CA', stateName: 'California' })).toBe(true)
    expect(namesOnlyRegion({ location: 'CA', state: 'CA', stateName: 'California' })).toBe(true)
    expect(namesOnlyRegion({ location: '', state: 'CA', stateName: 'California' })).toBe(true)
    expect(namesOnlyRegion({ location: 'Bayern', state: 'DE-BY', stateName: 'Bayern' })).toBe(true)
  })

  it('is not a park, a forest or a town', () => {
    expect(namesOnlyRegion({ location: SMMNRA, state: 'CA', stateName: 'California' })).toBe(false)
    expect(namesOnlyRegion({ location: 'Pacific Palisades, CA', state: 'CA', stateName: 'California' })).toBe(false)
    expect(namesOnlyRegion({ location: 'Grainau, Bayern', state: 'DE-BY', stateName: 'Bayern' })).toBe(false)
  })
})

describe('a better location', () => {
  it('never replaces one that already names something finer', () => {
    const agencyRow = osm(34.05613, -118.520032, { location: SMMNRA })
    expect(betterLocation(agencyRow, { managed: ring(SMMNRA, 34.05613, -118.520032), towns: [pacificPalisades] })).toBeNull()

    const curated = osm(34.05613, -118.520032, { location: 'Topanga State Park, CA' })
    expect(betterLocation(curated, { managed: [], towns: [pacificPalisades] })).toBeNull()
  })

  it('borrows the park a trail is surrounded by', () => {
    // Rivas Ridge Trail, inside the recreation area above the Palisades.
    const trail = osm(34.067136, -118.525675)
    expect(betterLocation(trail, { managed: ring(SMMNRA, 34.067136, -118.525675), towns: [pacificPalisades] }))
      .toEqual({ location: SMMNRA, basis: 'managed' })
  })

  it('prefers the park to the town, and falls back to the town', () => {
    const trail = osm(34.067136, -118.525675)
    expect(betterLocation(trail, { managed: [], towns: [pacificPalisades] }))
      .toEqual({ location: 'Pacific Palisades, CA', basis: 'town' })
  })

  it('does not put the Walk of Fame in a recreation area a few kilometres off', () => {
    // The nearest Santa Monica Mountains trails to Hollywood Boulevard are
    // Betty B. Dearing and Hastain, 6-7 km north-west.
    const walkOfFame = osm(34.101425, -118.332756)
    const managed: ManagedNeighbour[] = [
      { location: SMMNRA, latitude: 34.133209, longitude: -118.39954 },
      { location: SMMNRA, latitude: 34.108413, longitude: -118.412609 },
      { location: SMMNRA, latitude: 34.124765, longitude: -118.390779 },
      { location: SMMNRA, latitude: 34.130000, longitude: -118.370000 },
    ]
    expect(betterLocation(walkOfFame, { managed, towns: [hollywood] }))
      .toEqual({ location: 'Hollywood, CA', basis: 'town' })
  })

  it('wants the park on most sides, not just one', () => {
    // A trail at the edge of a unit: plenty of its trails, all to the north.
    const point = { lat: 34.05, lng: -118.5 }
    const north = [0.4, 1, 2, 3, 4].map(km => ({ location: SMMNRA, latitude: point.lat + km / 111, longitude: point.lng + (km % 2 ? 0.01 : -0.01) }))
    expect(managedAreaAround(osm(point.lat, point.lng), north)).toBeNull()
  })

  it('wants more than a stray agency trail or two', () => {
    const point = { lat: 34.05, lng: -118.5 }
    expect(managedAreaAround(osm(point.lat, point.lng), ring(SMMNRA, point.lat, point.lng).slice(0, 3))).toBeNull()
  })

  it('needs one of the unit\'s trails close by', () => {
    const point = { lat: 34.05, lng: -118.5 }
    expect(managedAreaAround(osm(point.lat, point.lng), ring(SMMNRA, point.lat, point.lng, 2, 4))).toBeNull()
  })

  it('stays out of a place where two units meet', () => {
    const point = { lat: 34.25, lng: -118.2 }
    const managed = [
      ...ring('Angeles National Forest, CA', point.lat, point.lng),
      ...ring(SMMNRA, point.lat, point.lng).slice(0, 3),
    ]
    expect(managedAreaAround(osm(point.lat, point.lng), managed)).toBeNull()
  })

  it('ignores a unit in another state and a label that names only an agency', () => {
    const point = { lat: 38.95, lng: -119.95 }
    expect(managedAreaAround(osm(point.lat, point.lng), ring('Lake Tahoe Basin Management Unit, NV', point.lat, point.lng))).toBeNull()
    expect(managedAreaAround(osm(point.lat, point.lng), ring('National Forest System, CA', point.lat, point.lng))).toBeNull()
    expect(managedAreaAround(osm(point.lat, point.lng), ring('National Park Service, CA', point.lat, point.lng))).toBeNull()
  })

  it('leaves a trail with nothing near enough as it is', () => {
    const remote = osm(35.5, -116.5)
    expect(betterLocation(remote, { managed: [], towns: [{ ...hollywood, distanceKm: 40 }] })).toBeNull()
    expect(betterLocation(remote, { managed: [], towns: [] })).toBeNull()
  })

  it('does not name a long trail after the town at its middle', () => {
    // A 40 km wide relation: no one town describes it.
    const long = osm(34.067136, -118.525675, { minLat: 33.9, maxLat: 34.2, minLng: -118.7, maxLng: -118.4 })
    expect(betterLocation(long, { managed: [], towns: [pacificPalisades] })).toBeNull()
    // A unit's name stretches further than a town's.
    expect(betterLocation(long, { managed: ring(SMMNRA, 34.067136, -118.525675), towns: [pacificPalisades] }))
      .toEqual({ location: SMMNRA, basis: 'managed' })
  })

  it('skips a row with no usable position', () => {
    expect(betterLocation(osm(0, 0), { managed: [], towns: [pacificPalisades] })).toBeNull()
    expect(betterLocation(osm(Number.NaN, -118.5), { managed: [], towns: [pacificPalisades] })).toBeNull()
  })
})

describe('the nearest town', () => {
  it('is written "Town, ST" in the US and "Town, Region" in the Alps', () => {
    expect(formatTownLocation('Pacific Palisades', { country: 'US', state: 'CA', stateName: 'California' })).toBe('Pacific Palisades, CA')
    expect(formatTownLocation('Grainau', { country: 'DE', state: 'DE-BY', stateName: 'Bayern' })).toBe('Grainau, Bayern')
    expect(formatTownLocation('Ehrwald', { country: 'AT', state: 'AT-7', stateName: 'Tirol' })).toBe('Ehrwald, Tirol')
  })

  it('uses the local name where GeoNames has the English one', () => {
    expect(formatTownLocation('Munich', { country: 'DE', state: 'DE-BY', stateName: 'Bayern' })).toBe('München, Bayern')
  })

  it('skips a town over the border for the nearest on this side', () => {
    // Via Alpina Red R45 is in Bavaria. Its nearest town, Leutasch, is in Tirol.
    const trail = bavarian(47.42, 11.2)
    const towns: NearbyTown[] = [
      { name: 'Leutasch', lat: 47.3689, lng: 11.14404, distanceKm: 6.3 },
      { name: 'Mittenwald', lat: 47.4422, lng: 11.26187, distanceKm: 8.7 },
      { name: 'Grainau', lat: 47.47614, lng: 11.02405, distanceKm: 8.8 },
    ]
    expect(townAround(trail, towns)).toBe('Mittenwald, Bayern')
  })

  it('does not label a Nevada trail with a California town', () => {
    const stateline = osm(38.962, -119.94, { location: 'Nevada', state: 'NV', stateName: 'Nevada' })
    expect(townAround(stateline, [{ name: 'South Lake Tahoe', lat: 38.93324, lng: -119.98435, distanceKm: 5 }])).toBeNull()
  })

  it('says nothing when the town is the region itself', () => {
    const berlin = osm(52.52, 13.4, { location: 'Berlin', country: 'DE', state: 'DE-BE', stateName: 'Berlin' })
    expect(townAround(berlin, [{ name: 'Berlin', lat: 52.52437, lng: 13.41053, distanceKm: 1 }])).toBeNull()
  })
})

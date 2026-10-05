import type { ManagedNeighbour, NearbyTown, TrailPlace } from '../../app/Support/trailLocation'
import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { betterLocation, crossesRidge, formatTownLocation, geonamesRegionCode, managedAreaAround, namesOnlyRegion, operatorUnit, pointsBetween, RIDGE_RISE_M, townAround, townNear, unitKey } from '../../app/Support/trailLocation'

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
    expect(betterLocation(remote, { managed: [], towns: [{ ...hollywood, distanceKm: 60 }] })).toBeNull()
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

/*
 * The rules added for the 30,833 production trails a full pass left naming
 * only their region. Every coordinate, town and agency trail below is a real
 * production row or GeoNames place from that sample.
 */

/** The agency units a production catalog knows, as `agencyUnits()` reads them. */
const UNITS = new Map([
  'Colville National Forest',
  'Tahoe National Forest',
  'Mt. Baker-Snoqualmie National Forest',
  'Idaho Panhandle National Forests',
  'North Cascades National Park',
  'National Forest System',
].map(unit => [unitKey(unit), unit]))

function washington(latitude: number, longitude: number, extra: Partial<TrailPlace> = {}): TrailPlace {
  return osm(latitude, longitude, { location: 'Washington', state: 'WA', stateName: 'Washington', ...extra })
}

describe('the park or forest a trail\'s operator names', () => {
  it('takes a federal unit the agency rows know, in their spelling', () => {
    // Forest Road 7078, tagged operator=Colville National Forest.
    const road = washington(48.944526, -117.528432, { managedBy: 'Colville National Forest' })
    expect(betterLocation(road, { managed: [], towns: [], units: UNITS }))
      .toEqual({ location: 'Colville National Forest, WA', basis: 'operator' })

    // Pioneer Trail, tagged "USFS Tahoe National Forest".
    const pioneer = osm(39.316525, -120.65853, { managedBy: 'USFS Tahoe National Forest' })
    expect(operatorUnit(pioneer, UNITS)).toBe('Tahoe National Forest, CA')

    // "Mt. Baker-Snoqualmie" however the tag punctuates it.
    const bell = washington(48.710581, -121.878234, { managedBy: 'Mt Baker Snoqualmie National Forest' })
    expect(operatorUnit(bell, UNITS)).toBe('Mt. Baker-Snoqualmie National Forest, WA')
  })

  it('does not take a misspelt or unknown federal unit', () => {
    const typo = washington(48.9, -117.4, { managedBy: 'Coville National Forest' })
    expect(operatorUnit(typo, UNITS)).toBeNull()
    expect(operatorUnit(washington(48.9, -117.4, { managedBy: 'Colville National Forest' }), undefined)).toBeNull()
  })

  it('does not take an agency rather than a unit', () => {
    for (const managedBy of ['US Forest Service', 'National Park Service', 'BLM', 'National Forest System', 'Utah State Parks', 'Friends of Patapsco Valley State Park'])
      expect(operatorUnit(washington(48.9, -117.4, { managedBy }), UNITS)).toBeNull()
  })

  it('takes a state park or a refuge as the tag spells it', () => {
    // OJI Trail in Baxter State Park, tagged with the park authority.
    const oji = osm(45.921366, -69.025789, { location: 'Maine', state: 'ME', stateName: 'Maine', managedBy: 'Baxter State Park Authority' })
    expect(operatorUnit(oji, UNITS)).toBe('Baxter State Park, ME')

    const refuge = osm(31.6, -111.5, { location: 'Arizona', state: 'AZ', stateName: 'Arizona', managedBy: 'Buenos Aires NWR' })
    expect(operatorUnit(refuge, UNITS)).toBe('Buenos Aires National Wildlife Refuge, AZ')
  })

  it('takes a Naturpark, but not the society that runs one', () => {
    const hessen = (managedBy: string) => osm(50.130443, 9.467939, { location: 'Hessen', country: 'DE', state: 'DE-HE', stateName: 'Hessen', managedBy })
    expect(operatorUnit(hessen('Naturpark Hessischer Spessart'), UNITS)).toBe('Naturpark Hessischer Spessart, Hessen')
    expect(operatorUnit(hessen('Naturpark Wendland.Elbe e.V.'), UNITS)).toBeNull()
    expect(operatorUnit(hessen('Nationalpark- und Forstverwaltung Sächsische Schweiz'), UNITS)).toBeNull()
  })

  it('reads each body in a list', () => {
    const shared = washington(48.6, -121.3, { managedBy: 'North Country Trail Association;North Cascades National Park' })
    expect(operatorUnit(shared, UNITS)).toBe('North Cascades National Park, WA')
  })

  it('never replaces a location that already names a place', () => {
    const named = washington(48.944526, -117.528432, { location: 'Republic, WA', managedBy: 'Colville National Forest' })
    expect(betterLocation(named, { managed: [], towns: [], units: UNITS })).toBeNull()
  })
})

describe('towns over the border', () => {
  it('steps past a crowd of Italian villages to the Swiss town on this side', () => {
    // Zwischbergentalstrasse, in Valais: the eight nearest places are Italian.
    const trail = osm(46.149211, 8.107849, { location: 'Kanton Wallis', country: 'CH', state: 'CH-VS', stateName: 'Kanton Wallis' })
    const towns: NearbyTown[] = [
      { name: 'San Lorenzo', lat: 46.1272, lng: 8.20065, distanceKm: 7.6, feature: 'PPLA3', country: 'IT', regionCode: '12' },
      { name: 'Antronapiana', lat: 46.06091, lng: 8.11519, distanceKm: 9.8, feature: 'PPLA3', country: 'IT', regionCode: '12' },
      { name: 'Antrona Schieranco', lat: 46.06038, lng: 8.11461, distanceKm: 9.8, feature: 'PPLA3', country: 'IT', regionCode: '12' },
      { name: 'Trasquera', lat: 46.21338, lng: 8.21271, distanceKm: 10.8, feature: 'PPLA3', country: 'IT', regionCode: '12' },
      { name: 'Viganella', lat: 46.05173, lng: 8.19374, distanceKm: 12.7, feature: 'PPLA3', country: 'IT', regionCode: '12' },
      { name: 'Varzo', lat: 46.20736, lng: 8.25267, distanceKm: 12.9, feature: 'PPLA3', country: 'IT', regionCode: '12' },
      { name: 'Seppiana', lat: 46.05828, lng: 8.21661, distanceKm: 13.1, feature: 'PPLA3', country: 'IT', regionCode: '12' },
      { name: 'Montescheno', lat: 46.06658, lng: 8.23192, distanceKm: 13.2, feature: 'PPLA3', country: 'IT', regionCode: '12' },
      { name: 'Saas-Grund', lat: 46.12281, lng: 7.93651, distanceKm: 13.5, feature: 'PPL', country: 'CH', regionCode: 'VS' },
    ]
    expect(townAround(trail, towns)).toBe('Saas-Grund, Kanton Wallis')
  })

  it('trusts the gazetteer\'s canton over the simplified outline', () => {
    // Rütiweid, in the Oberegg enclave of Innerrhoden. The outline puts Gais
    // in Innerrhoden too; it is in Ausserrhoden.
    const trail = osm(47.409344, 9.515726, { location: 'Kanton Appenzell Innerrhoden', country: 'CH', state: 'CH-AI', stateName: 'Kanton Appenzell Innerrhoden' })
    const gais: NearbyTown = { name: 'Gais', lat: 47.3615, lng: 9.45356, distanceKm: 7.1, feature: 'PPL', country: 'CH', regionCode: 'AR' }
    expect(townAround(trail, [gais])).toBeNull()
    expect(townAround(trail, [
      { name: 'Rehetobel', lat: 47.42611, lng: 9.483, distanceKm: 3.1, feature: 'PPL', country: 'CH', regionCode: 'AR' },
      { name: 'Oberegg', lat: 47.42531, lng: 9.55134, distanceKm: 3.2, feature: 'PPL', country: 'CH', regionCode: 'AI' },
      gais,
    ])).toBe('Oberegg, Kanton Appenzell Innerrhoden')
  })

  it('maps each region to the code GeoNames files its towns under', () => {
    expect(geonamesRegionCode({ country: 'US', state: 'WA' })).toBe('WA')
    expect(geonamesRegionCode({ country: 'CH', state: 'CH-AI' })).toBe('AI')
    expect(geonamesRegionCode({ country: 'AT', state: 'AT-2' })).toBe('02')
    expect(geonamesRegionCode({ country: 'DE', state: 'DE-BY' })).toBe('02')
    expect(geonamesRegionCode({ country: 'DE', state: 'DE-SN' })).toBe('13')
    expect(geonamesRegionCode({ country: 'FR', state: 'FR-ARA' })).toBeNull()
  })
})

describe('the back country', () => {
  // Park Creek, Glacier National Park: the park's own trails 0.5-9 km off on
  // three sides, and the nearest town, Browning, 43 km away over the Divide.
  const parkCreek = osm(48.35265, -113.523834, { location: 'Montana', state: 'MT', stateName: 'Montana' })
  const glacier: ManagedNeighbour[] = [
    { location: 'Glacier National Park, MT', latitude: 48.349334, longitude: -113.529288 },
    { location: 'Glacier National Park, MT', latitude: 48.344903, longitude: -113.545165 },
    { location: 'Glacier National Park, MT', latitude: 48.332082, longitude: -113.461914 },
    { location: 'Glacier National Park, MT', latitude: 48.290415, longitude: -113.581584 },
    { location: 'Glacier National Park, MT', latitude: 48.298806, longitude: -113.447787 },
    { location: 'Glacier National Park, MT', latitude: 48.423242, longitude: -113.47326 },
    { location: 'Glacier National Park, MT', latitude: 48.284926, longitude: -113.598831 },
  ]
  const browning: NearbyTown = { name: 'South Browning', lat: 48.54608, lng: -113.01425, distanceKm: 43.3, feature: 'PPL', country: 'US', regionCode: 'MT' }

  it('finds the park from its trails a few kilometres apart', () => {
    // Two of the park's trails within 5 km: too few among towns.
    expect(managedAreaAround(parkCreek, glacier)).toBeNull()
    expect(betterLocation(parkCreek, { managed: glacier, towns: [browning] }))
      .toEqual({ location: 'Glacier National Park, MT', basis: 'managed' })
  })

  it('judges the wider circle only where there is no town of the region close by', () => {
    const town: NearbyTown = { name: 'Apgar', lat: 48.3, lng: -113.6, distanceKm: 8, feature: 'PPL', country: 'US', regionCode: 'MT' }
    expect(betterLocation(parkCreek, { managed: glacier, towns: [town] }))
      .toEqual({ location: 'Apgar, MT', basis: 'town' })
  })

  it('still wants the unit on most sides, and nine in ten of the trails around', () => {
    // The same trails, only those to the south-west: the edge of the park.
    const oneSide = glacier.filter(n => n.latitude < 48.35265 && n.longitude < -113.523834)
    expect(managedAreaAround(parkCreek, oneSide, true)).toBeNull()

    // A second unit with a couple of trails in the circle.
    const contested = [...glacier, ...glacier.slice(0, 2).map(n => ({ ...n, location: 'Flathead National Forest, MT' }))]
    expect(managedAreaAround(parkCreek, contested, true)).toBeNull()

    // Three trails is not enough to say where a park is.
    expect(managedAreaAround(parkCreek, glacier.slice(0, 3), true)).toBeNull()
  })

  it('calls a town 25-45 km off near, not in', () => {
    // Lunch Meadow Trail, Emigrant Wilderness: Bridgeport is the nearest town.
    // (Whether a ridge is between them is the caller's to check, below.)
    const lunchMeadow = osm(38.171282, -119.605681)
    const bridgeport: NearbyTown = { name: 'Bridgeport', lat: 38.25575, lng: -119.23127, distanceKm: 34.1, feature: 'PPLA2', country: 'US', regionCode: 'CA' }
    expect(betterLocation(lunchMeadow, { managed: [], towns: [bridgeport] }))
      .toEqual({ location: 'Near Bridgeport, CA', basis: 'near-town', town: { lat: 38.25575, lng: -119.23127 } })
  })

  it('does not call a town near past 45 km', () => {
    const lunchMeadow = osm(38.171282, -119.605681)
    expect(townNear(lunchMeadow, [{ name: 'Yosemite Valley', lat: 37.74075, lng: -119.57788, distanceKm: 47.7, feature: 'PPL', country: 'US', regionCode: 'CA' }])).toBeNull()
  })

  it('does not call a far town near when one over the border is close', () => {
    // Estes Canyon Trail, Organ Pipe Cactus: Sonoyta, Mexico, is 22 km off
    // and Ajo 42. The trail is not usefully "near Ajo".
    const estesCanyon = osm(32.020199, -112.704009, { location: 'Arizona', state: 'AZ', stateName: 'Arizona' })
    const towns: NearbyTown[] = [
      { name: 'Sonoyta', lat: 31.86323, lng: -112.85012, distanceKm: 22.2, feature: 'PPLA2', country: 'MX', regionCode: '26' },
      { name: 'Ajo', lat: 32.37172, lng: -112.86071, distanceKm: 41.6, feature: 'PPL', country: 'US', regionCode: 'AZ' },
    ]
    expect(betterLocation(estesCanyon, { managed: [], towns })).toBeNull()

    // Old Traction Road, California: Sandy Valley, Nevada, is 13 km off, and
    // no California town is within 45.
    const traction = osm(35.701429, -115.62587)
    const sandyValley: NearbyTown = { name: 'Sandy Valley', lat: 35.81692, lng: -115.63223, distanceKm: 12.8, feature: 'PPL', country: 'US', regionCode: 'NV' }
    expect(betterLocation(traction, { managed: [], towns: [sandyValley] })).toBeNull()
  })

  it('is never near a section of a city', () => {
    const trail = osm(34.4, -117.9)
    expect(townNear(trail, [{ name: 'Some Neighbourhood', lat: 34.2, lng: -118.2, distanceKm: 35, feature: 'PPLX', country: 'US', regionCode: 'CA' }])).toBeNull()
  })

  it('keeps a long trail near no one town', () => {
    const long = osm(38.171282, -119.605681, { minLat: 38, maxLat: 38.4, minLng: -119.8, maxLng: -119.4 })
    const bridgeport: NearbyTown = { name: 'Bridgeport', lat: 38.25575, lng: -119.23127, distanceKm: 34.1, feature: 'PPLA2', country: 'US', regionCode: 'CA' }
    expect(betterLocation(long, { managed: [], towns: [bridgeport] })).toBeNull()
  })
})

describe('a town some way off', () => {
  it('comes with its point, for the ground between to be looked at', () => {
    // Via Peter Aebli, Val Müstair: the only Graubünden town in the gazetteer
    // within 25 km is Scuol, 20 km north over the Sesvenna group.
    const trail = osm(46.614125, 10.365599, { location: 'Kanton Graubünden', country: 'CH', state: 'CH-GR', stateName: 'Kanton Graubünden' })
    const towns: NearbyTown[] = [
      { name: 'Tubre', lat: 46.64403, lng: 10.46328, distanceKm: 8.2, feature: 'PPLA3', country: 'IT', regionCode: '17' },
      { name: 'Scuol', lat: 46.79671, lng: 10.29804, distanceKm: 20.9, feature: 'PPL', country: 'CH', regionCode: 'GR' },
    ]
    expect(betterLocation(trail, { managed: [], towns }))
      .toEqual({ location: 'Scuol, Kanton Graubünden', basis: 'town', town: { lat: 46.79671, lng: 10.29804 } })
  })

  it('needs no look when the town is close', () => {
    expect(betterLocation(osm(34.067136, -118.525675), { managed: [], towns: [pacificPalisades] }))
      .toEqual({ location: 'Pacific Palisades, CA', basis: 'town' })
  })
})

describe('a ridge between a trail and its town', () => {
  // Heights in metres at 20 points along the straight line, from Valhalla,
  // trail first.
  it('stops Lunch Meadow being near Bridgeport, across the Sierra crest', () => {
    const lunchMeadowToBridgeport = [2864, 2872, 2882, 2853, 2708, 3167, 3055, 3186, 3352, 2774, 2297, 2600, 2512, 2384, 2245, 2052, 2011, 1993, 1979, 1970]
    expect(crossesRidge(lunchMeadowToBridgeport)).toBe(true)
  })

  it('stops Montgomery Pass being near Estes Park, across the Mummy Range', () => {
    const montgomeryPassToEstesPark = [3223, 3201, 3432, 3419, 3354, 3103, 3193, 3156, 3145, 3298, 3534, 3539, 3217, 2911, 3320, 2788, 2575, 2509, 2397, 2295]
    expect(crossesRidge(montgomeryPassToEstesPark)).toBe(true)
  })

  it('lets a trail down the valley from its town be near it', () => {
    // Raymond Fisher Trail to Brevard, NC: rolling, never above the trail.
    const raymondFisherToBrevard = [882, 803, 672, 858, 840, 867, 864, 790, 777, 738, 687, 751, 732, 700, 674, 680, 741, 695, 652, 678]
    expect(crossesRidge(raymondFisherToBrevard)).toBe(false)
    // A shoulder below the rise allowed is a hillside, not a ridge.
    expect(crossesRidge([1000, 1100, 1000 + RIDGE_RISE_M - 1, 900, 800])).toBe(false)
  })

  it('cannot tell without both ends, or with most of the line missing', () => {
    expect(crossesRidge([null, 1000, 1200, 900])).toBeNull()
    expect(crossesRidge([900, 1000, 1200, null])).toBeNull()
    expect(crossesRidge([900, null, null, null, 800])).toBeNull()
    expect(crossesRidge([])).toBeNull()
  })

  it('samples the straight line, both ends included', () => {
    const points = pointsBetween({ lat: 38, lng: -120 }, { lat: 39, lng: -119 }, 5)
    expect(points).toHaveLength(5)
    expect(points[0]).toEqual({ lat: 38, lng: -120 })
    expect(points[2]).toEqual({ lat: 38.5, lng: -119.5 })
    expect(points[4]).toEqual({ lat: 39, lng: -119 })
  })
})

describe('asking the region-only trails again', () => {
  /** The migration, run the way the runner runs it: split on semicolons, comments dropped. */
  async function recheck(db: Database): Promise<void> {
    const text = await Bun.file('database/migrations/0000000201-recheck-region-only-trail-locations.sql').text()
    for (const statement of text.split(';')) {
      const sql = statement.split('\n').filter(line => !line.trim().startsWith('--')).join('\n').trim()
      if (sql)
        db.run(sql)
    }
  }

  it('clears the stamp on trails that still name only their region, and no other', async () => {
    const db = new Database(':memory:')
    db.run(`CREATE TABLE trails (id INTEGER PRIMARY KEY, location TEXT, geometry TEXT, state TEXT, state_name TEXT, location_checked_at TEXT)`)
    db.run(`CREATE INDEX trails_trails_country_state_name_index ON trails (state, state_name)`)
    const insert = db.prepare('INSERT INTO trails (id, location, state, state_name, location_checked_at) VALUES (?, ?, ?, ?, ?)')
    const rows: Array<[number, string | null, string, string, string | null]> = [
      [1, 'California', 'CA', 'California', '2026-10-01'],
      [2, 'CA', 'CA', 'California', '2026-10-01'],
      [3, '', 'CA', 'California', '2026-10-01'],
      [4, 'Kanton Wallis', 'CH-VS', 'Kanton Wallis', '2026-10-01'],
      // Named after a park or a town: settled, and stays settled.
      [5, 'Pacific Palisades, CA', 'CA', 'California', '2026-10-01'],
      [6, 'Colville National Forest, WA', 'WA', 'Washington', '2026-10-01'],
      // A town that shares a region name, in another region.
      [7, 'Washington', 'PA', 'Pennsylvania', '2026-10-01'],
      // Never asked: nothing to clear.
      [8, 'Oregon', 'OR', 'Oregon', null],
    ]
    for (const row of rows)
      insert.run(...row)

    await recheck(db)

    const unchecked = db.query('SELECT id FROM trails WHERE location_checked_at IS NULL ORDER BY id').all().map((row: any) => row.id)
    expect(unchecked).toEqual([1, 2, 3, 4, 8])
    db.close()
  })
})

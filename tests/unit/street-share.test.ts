import type { OverpassElement } from '../../app/Ingest/sources/osm'
import type { RouteMember } from '../../app/Support/streetShare'
import { describe, expect, it } from 'bun:test'
import { normalizeElement, normalizeElements } from '../../app/Ingest/sources/osm'
import { isStreetWay, streetShare } from '../../app/Support/streetShare'

/**
 * Telling a street walk from a trail (app/Support/streetShare.ts).
 *
 * Every route below is a real OpenStreetMap relation around Los Angeles,
 * Munich or Zug, with its member ways summed by tag (the meters are the
 * members' lengths as Overpass returned them, October 2026). What decides a route is how much of
 * it runs along a street, not what it is paved with or whether it is in a
 * city — so the river paths and Venice's beach path are here as deliberately
 * as the Walk of Fame.
 */

const share = (members: RouteMember[]) => streetShare(members)

/** relation/2400284: route=foot, roundtrip=yes, tourism=attraction. */
const WALK_OF_FAME: RouteMember[] = [
  { tags: { highway: 'footway', footway: 'sidewalk' }, meters: 4899 },
  { tags: { highway: 'footway', footway: 'crossing' }, meters: 551 },
]

/** relation/13952130: California Mission Trail, stage 04, San Gabriel to San Fernando. */
const MISSION_TRAIL_STAGE_04: RouteMember[] = [
  { tags: { highway: 'primary' }, meters: 18067 },
  { tags: { highway: 'secondary' }, meters: 10652 },
  { tags: { highway: 'tertiary' }, meters: 4377 },
  { tags: { highway: 'primary', 'sidewalk:both': 'separate' }, meters: 4193 },
  { tags: { highway: 'tertiary', 'sidewalk:both': 'separate' }, meters: 3292 },
  { tags: { highway: 'secondary', 'sidewalk': 'both' }, meters: 1203 },
  { tags: { highway: 'residential' }, meters: 929 },
  { tags: { highway: 'footway', footway: 'sidewalk' }, meters: 185 },
  { tags: { highway: 'footway', footway: 'crossing' }, meters: 104 },
]

/** relation/7645522: a crosswalk and a residential street to the trailhead, then canyon. */
const FLINT_CANYON: RouteMember[] = [
  { tags: { highway: 'path' }, meters: 3067 },
  { tags: { highway: 'residential' }, meters: 234 },
  { tags: { highway: 'service' }, meters: 88 },
  { tags: { highway: 'footway', footway: 'crossing' }, meters: 84 },
]

/** relation/8435422: Baldwin Hills to the beach, on bike paths and dirt, across a few streets. */
const PARK_TO_PLAYA: RouteMember[] = [
  { tags: { highway: 'cycleway' }, meters: 10672 },
  { tags: { highway: 'path' }, meters: 5937 },
  { tags: { highway: 'footway' }, meters: 1861 },
  { tags: { highway: 'footway', footway: 'sidewalk' }, meters: 492 },
  { tags: { highway: 'track' }, meters: 381 },
  { tags: { highway: 'footway', footway: 'crossing' }, meters: 186 },
  { tags: { highway: 'residential', 'sidewalk:both': 'no' }, meters: 160 },
  { tags: { highway: 'tertiary', 'sidewalk:both': 'separate' }, meters: 153 },
  { tags: { highway: 'residential', 'sidewalk:left': 'no', 'sidewalk:right': 'separate' }, meters: 153 },
  { tags: { highway: 'residential', 'sidewalk:left': 'separate', 'sidewalk:right': 'no' }, meters: 114 },
  { tags: { highway: 'steps' }, meters: 46 },
  { tags: { highway: 'footway', footway: 'traffic_island' }, meters: 15 },
]

/** relation/20012080: Azusa to Seal Beach on the levee. */
const SAN_GABRIEL_RIVER_TRAIL: RouteMember[] = [
  { tags: { highway: 'cycleway', surface: 'paved' }, meters: 33287 },
  { tags: { highway: 'path', surface: 'dirt' }, meters: 19034 },
  { tags: { highway: 'bridleway' }, meters: 4747 },
  { tags: { highway: 'service' }, meters: 40 },
]

/** relation/12149115: called a road, walked on a track. */
const MOUNT_WILSON_TOLL_ROAD: RouteMember[] = [
  { tags: { highway: 'track', surface: 'unpaved' }, meters: 24827 },
  { tags: { highway: 'service', surface: 'paved' }, meters: 83 },
]

/** relation/11825333, Zug: a signed Wanderweg between two hamlets, on one farm lane. */
const ERLENBACH_SARBACH: RouteMember[] = [
  { tags: { highway: 'unclassified' }, meters: 1907 },
]

/** relation/15073229, Munich: a city history walk, "KulturGeschichtsPfad 12, Zweiter Spaziergang". */
const KULTURGESCHICHTSPFAD_12: RouteMember[] = [
  { tags: { highway: 'residential', sidewalk: 'both' }, meters: 1875 },
  { tags: { highway: 'footway', footway: 'sidewalk' }, meters: 588 },
  { tags: { highway: 'residential', 'sidewalk:left': 'yes', 'sidewalk:right': 'separate' }, meters: 335 },
  { tags: { highway: 'pedestrian' }, meters: 235 },
  { tags: { highway: 'residential' }, meters: 186 },
  { tags: { highway: 'residential', sidewalk: 'left' }, meters: 157 },
  { tags: { highway: 'path', footway: 'sidewalk' }, meters: 140 },
  { tags: { highway: 'footway' }, meters: 77 },
  { tags: { highway: 'path' }, meters: 40 },
  { tags: { highway: 'residential', sidewalk: 'right' }, meters: 22 },
]

/** relation/12315697: out of Kirchseeon on the town's sidewalks, into Grafing on farm lanes. */
const KIRCHSEEON_GRAFING: RouteMember[] = [
  { tags: { highway: 'footway', footway: 'sidewalk' }, meters: 1195 },
  { tags: { highway: 'unclassified' }, meters: 742 },
  { tags: { highway: 'residential', sidewalk: 'no' }, meters: 522 },
  { tags: { highway: 'footway', footway: 'crossing' }, meters: 20 },
  { tags: { highway: 'residential' }, meters: 19 },
]

/**
 * Ocean Front Walk ("The Strand") and the Venice Beach Bike Path, the ways
 * between Venice Pier and the Santa Monica line. Ways rather than a relation
 * in OpenStreetMap; summed here as the route a relation of them would be.
 */
const VENICE_BEACH: RouteMember[] = [
  { tags: { highway: 'cycleway', surface: 'concrete' }, meters: 2793 },
  { tags: { highway: 'footway', surface: 'paved' }, meters: 1645 },
  { tags: { highway: 'footway' }, meters: 703 },
  { tags: { highway: 'footway', surface: 'asphalt' }, meters: 490 },
  { tags: { highway: 'path', surface: 'sand' }, meters: 471 },
  { tags: { highway: 'footway', footway: 'crossing' }, meters: 21 },
]

describe('what a street is', () => {
  it('counts sidewalks, crosswalks, pedestrian streets and through roads', () => {
    for (const tags of [
      { highway: 'footway', footway: 'sidewalk' },
      { highway: 'footway', footway: 'crossing' },
      { highway: 'pedestrian' },
      { highway: 'tertiary' },
      { highway: 'primary', surface: 'asphalt' },
    ])
      expect(isStreetWay(tags), JSON.stringify(tags)).toBe(true)
  })

  it('does not count paths for being paved, lit or in a city', () => {
    // Paseo del Rio (way/892086107), the LA River greenway in Cypress Park.
    expect(isStreetWay({ highway: 'path', lit: 'yes', bicycle: 'yes', foot: 'yes', motor_vehicle: 'private' })).toBe(false)
    // Ocean Front Walk (way/121942893), Venice: paved, lit, car-free, on the sand.
    expect(isStreetWay({ highway: 'footway', surface: 'paved', lit: 'yes', foot: 'designated', bicycle: 'dismount' })).toBe(false)
    expect(isStreetWay({ highway: 'cycleway', surface: 'concrete' })).toBe(false)
  })

  it('leaves fire roads alone, which in a park are service roads', () => {
    expect(isStreetWay({ highway: 'service' })).toBe(false)
    expect(isStreetWay({ highway: 'track', tracktype: 'grade2' })).toBe(false)
  })

  it('counts a minor road as a street only where it has a pavement', () => {
    // A farm lane or a village street: how Wanderwege get between villages.
    expect(isStreetWay({ highway: 'unclassified' })).toBe(false)
    expect(isStreetWay({ highway: 'residential' })).toBe(false)
    expect(isStreetWay({ highway: 'residential', sidewalk: 'no' })).toBe(false)
    expect(isStreetWay({ highway: 'residential', 'sidewalk:both': 'no' })).toBe(false)
    // A town street, with a pavement on either side or mapped beside it.
    expect(isStreetWay({ highway: 'residential', sidewalk: 'both' })).toBe(true)
    expect(isStreetWay({ highway: 'residential', 'sidewalk:left': 'no', 'sidewalk:right': 'separate' })).toBe(true)
    expect(isStreetWay({ highway: 'living_street', sidewalk: 'left' })).toBe(true)
  })
})

describe('how much of a route is street', () => {
  it('finds the Walk of Fame and a stage of the Mission Trail are street', () => {
    expect(share(WALK_OF_FAME)).toBe(1)
    // All but a residential street with no pavement mapped.
    expect(share(MISSION_TRAIL_STAGE_04)).toBeCloseTo(0.98, 2)
  })

  it('finds a city history walk in Munich is street', () => {
    expect(share(KULTURGESCHICHTSPFAD_12)).toBeCloseTo(0.92, 2)
  })

  it('finds a Wanderweg along a farm lane is not', () => {
    // Judged deliberately: a quiet lane between hamlets is how the signed
    // Swiss and Bavarian networks get from one village to the next.
    expect(share(ERLENBACH_SARBACH)).toBe(0)
  })

  it('finds a route half on town sidewalks is half street', () => {
    expect(share(KIRCHSEEON_GRAFING)).toBeCloseTo(0.49, 2)
  })

  it('finds a canyon trail reached by a crosswalk and a street is trail', () => {
    expect(share(FLINT_CANYON)).toBeCloseTo(0.024, 2)
  })

  it('finds river paths and a cross-town greenway are not streets', () => {
    expect(share(PARK_TO_PLAYA)).toBeCloseTo(0.055, 2)
    expect(share(SAN_GABRIEL_RIVER_TRAIL)).toBe(0)
  })

  it('finds a road by name is not a street by tag', () => {
    expect(share(MOUNT_WILSON_TOLL_ROAD)).toBe(0)
  })

  it('finds the beach path at Venice is a walk, not a sidewalk', () => {
    // Judged deliberately: the boardwalk is a promenade in the middle of a
    // city, but nothing on it runs beside traffic. Its few crosswalks are
    // where it meets the street ends.
    expect(share(VENICE_BEACH)).toBeLessThan(0.01)
  })

  it('weighs members by length, so a dozen crosswalks do not make a street', () => {
    const crossings = Array.from({ length: 12 }, () => ({ tags: { highway: 'footway', footway: 'crossing' }, meters: 15 }))
    expect(share([{ tags: { highway: 'path' }, meters: 4000 }, ...crossings])).toBeLessThan(0.05)
  })

  it('leaves out members whose tags are not known, and knows nothing without any', () => {
    expect(share([{ tags: { highway: 'path' }, meters: 1000 }, { meters: 5000 }])).toBe(0)
    expect(share([{ meters: 5000 }])).toBeNull()
    expect(share([])).toBeNull()
  })
})

/*
 * The ingest's half: Overpass answers with the relations, then their member
 * ways' tags (no geometry), and the street share is read from the two.
 */

/** Points along a line of latitude, about `meters` long. */
function line(lat: number, lng: number, meters: number, points = 6): Array<{ lat: number, lon: number }> {
  const degrees = meters / (111_320 * Math.cos((lat * Math.PI) / 180))
  return Array.from({ length: points }, (_, i) => ({ lat, lon: lng + (degrees * i) / (points - 1) }))
}

/** The Walk of Fame as the tile query returns it: Hollywood Boulevard, both sides, and Vine Street. */
const walkOfFame: OverpassElement = {
  type: 'relation',
  id: 2400284,
  tags: { name: 'Hollywood Walk of Fame', route: 'foot', roundtrip: 'yes', tourism: 'attraction', historic: 'monument', type: 'route' },
  members: [
    { type: 'way', ref: 1, geometry: line(34.1018, -118.3420, 1800) },
    { type: 'way', ref: 2, geometry: line(34.1014, -118.3420, 1800) },
    { type: 'way', ref: 3, geometry: line(34.1016, -118.3266, 20, 2) },
  ],
}

const memberWays: OverpassElement[] = [
  { type: 'way', id: 1, tags: { highway: 'footway', footway: 'sidewalk', surface: 'paving_stones' } },
  { type: 'way', id: 2, tags: { highway: 'footway', footway: 'sidewalk', surface: 'tiles' } },
  { type: 'way', id: 3, tags: { highway: 'footway', footway: 'crossing' } },
]

/** Griffith Park: way/861162412. */
const mountHollywood: OverpassElement = {
  type: 'way',
  id: 861162412,
  tags: { highway: 'path', name: 'Mount Hollywood Trail', surface: 'dirt', horse: 'yes' },
  geometry: line(34.1266, -118.3050, 1600),
}

/** The LA River greenway: way/892086107. */
const paseoDelRio: OverpassElement = {
  type: 'way',
  id: 892086107,
  tags: { highway: 'path', name: 'Paseo del Rio', lit: 'yes', bicycle: 'yes', foot: 'yes', motor_vehicle: 'private' },
  geometry: line(34.1013, -118.2440, 2800),
}

describe('measuring at ingest', () => {
  it('measures a relation from its members\' tags', () => {
    const { trails } = normalizeElements([walkOfFame, ...memberWays])
    expect(trails).toHaveLength(1)
    expect(trails[0].name).toBe('Hollywood Walk of Fame')
    expect(trails[0].streetShare).toBe(1)
  })

  it('does not measure a way, which the query already asked for by its own tags', () => {
    const { trails } = normalizeElements([mountHollywood, paseoDelRio])
    expect(trails.map(trail => trail.name)).toEqual(['Mount Hollywood Trail', 'Paseo del Rio'])
    for (const trail of trails)
      expect(trail.streetShare, trail.name).toBeUndefined()
  })

  it('reads the members\' tags without taking them for trails', () => {
    // A trail way that is also a member comes back twice, whole and as tags.
    const { trails, seen } = normalizeElements([walkOfFame, mountHollywood, ...memberWays, { type: 'way', id: 861162412, tags: mountHollywood.tags }])
    expect(seen).toBe(2)
    expect(trails.map(trail => trail.name)).toEqual(['Hollywood Walk of Fame', 'Mount Hollywood Trail'])
  })

  it('says it knows nothing when no member\'s tags came back', () => {
    expect(normalizeElements([walkOfFame]).trails[0].streetShare).toBeNull()
  })

  it('measures nothing when asked without the members\' tags at all', () => {
    expect(normalizeElement(walkOfFame)?.streetShare).toBeUndefined()
  })
})

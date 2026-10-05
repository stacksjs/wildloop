/**
 * How much of a route is walked along streets.
 *
 * The ingest keeps sidewalks out by asking OpenStreetMap for named paths and
 * footways that are not `footway=sidewalk` (app/Ingest/sources/osm.ts). That
 * holds for a way, which carries its own tags. It does not hold for a route
 * relation, whose tags describe the route and say nothing about what it is
 * walked on: the Hollywood Walk of Fame is `route=foot`, `roundtrip=yes`,
 * `tourism=attraction` — tags a loop hike could carry — and every one of its
 * 103 members is a sidewalk or a crosswalk. It arrived as a 3-mile loop and
 * ranked sixth near downtown Los Angeles, ahead of most of Griffith Park.
 *
 * What gives a street walk away is its members, so it is measured there: the
 * share of a route's length on ways that are part of a street. Measured from
 * production relations around Los Angeles and Munich:
 *
 *   Hollywood Walk of Fame                  100%  sidewalks and crosswalks
 *   California Mission Trail, stage 04       98%  primary, secondary and tertiary roads
 *   KulturGeschichtsPfad 12, Munich          85%  town streets with pavements
 *   Kirchseeon - Grafing                     49%  half town sidewalks, half farm lanes
 *   Culver Boulevard Median Path              7%  a footway down a median, across side streets
 *   Park to Playa Trail                       6%  bike paths and dirt, across a few sidewalks
 *   Flint Canyon Trail                        2%  a crosswalk, then a residential street to the trailhead
 *   Erlenbach - Sarbach, Zug                  0%  a farm lane
 *   San Gabriel River Trail                   0%  levee bike path, dirt and bridleway
 *   Mount Wilson Toll Road                    0%  a track, for all that it is called a road
 *
 * Pavement is not the signal, and neither is being in a city. Paseo del Rio
 * along the Los Angeles River is a lit, paved `highway=path`, and Venice's
 * Ocean Front Walk and the beach path beside it are footways and cycleways on
 * the sand. People set out for those. Nobody plans a walk along a sidewalk
 * with traffic beside it, which is what both of the routes at the top are.
 */

/**
 * Streets wherever they are: roads from tertiary up, which carry traffic
 * through a village as much as through a city.
 *
 * Not `pedestrian`. It is a car-free way, and mappers use it for a beach
 * boardwalk as readily as for a shopping street: the Mission Beach boardwalk
 * in San Diego (relation/3570265, Oceanfront Walk) is `highway=pedestrian`,
 * and so is Old US 1 on the Old Bahia Honda Bridge Trail, a highway closed to
 * cars. With nothing beside it to walk next to, it is a walk, not a street.
 */
const STREET_HIGHWAYS = new Set([
  'road',
  'tertiary',
  'tertiary_link',
  'secondary',
  'secondary_link',
  'primary',
  'primary_link',
  'trunk',
  'trunk_link',
  'motorway',
  'motorway_link',
])

/**
 * Minor roads, which are streets only in a town.
 *
 * Counted as streets, these buried the countryside: the signed Wanderwege of
 * Switzerland and Bavaria run along farm lanes (`unclassified`) and through
 * village streets (`residential`) by design. Erlenbach - Sarbach, a Zug
 * hiking route, is 1.9 km of one `unclassified` lane, and 104 of 900 routes
 * sampled around Munich, Zurich, Los Angeles, Boulder and New York came out
 * at least half street. What marks a minor road as a town street is a
 * pavement: mappers tag `sidewalk` on streets that have one, and lanes have
 * none. Munich's KulturGeschichtsPfad walks are `residential` with
 * `sidewalk=both`; with only those counted, 14 of the 104 stay at least half
 * street, and every one is a city or suburban walk.
 */
const MINOR_ROADS = new Set(['residential', 'unclassified', 'living_street'])

/** Footways that exist only as part of a street: beside it, across it, or in the middle of it. */
const STREET_FOOTWAYS = new Set(['sidewalk', 'crossing', 'traffic_island'])

const SIDEWALK_KEYS = ['sidewalk', 'sidewalk:both', 'sidewalk:left', 'sidewalk:right']

/** Whether a road is mapped with a pavement beside it, on either side or mapped apart. */
function hasSidewalk(tags: Record<string, string>): boolean {
  return SIDEWALK_KEYS.some(key => Boolean(tags[key]) && tags[key] !== 'no' && tags[key] !== 'none')
}

/**
 * Surfaces no street has. A gravel county road is `tertiary` across much of
 * the rural West, and a long trail that follows one for a few miles is on a
 * backroad, not a street.
 */
const UNPAVED = new Set([
  'unpaved',
  'gravel',
  'fine_gravel',
  'pebblestone',
  'compacted',
  'dirt',
  'earth',
  'ground',
  'mud',
  'sand',
  'grass',
  'grass_paver',
  'rock',
  'woodchips',
])

/** Whether a way is part of a street rather than a path of its own. */
export function isStreetWay(tags: Record<string, string> | null | undefined): boolean {
  if (!tags || UNPAVED.has(tags.surface ?? ''))
    return false
  if (STREET_HIGHWAYS.has(tags.highway ?? '') || STREET_FOOTWAYS.has(tags.footway ?? ''))
    return true
  return MINOR_ROADS.has(tags.highway ?? '') && hasSidewalk(tags)
}

/** One member of a route: its tags, if known, and how long it is. */
export interface RouteMember {
  tags?: Record<string, string> | null
  meters: number
}

/**
 * The share of a route's length on streets, 0–1, or null when no member's
 * tags are known.
 *
 * By length, not by member count: a route crosses a road in a dozen short
 * crosswalks and is no more a street walk for it. Members whose tags are not
 * known are left out of both sides rather than counted as either.
 */
export function streetShare(members: RouteMember[]): number | null {
  let known = 0
  let street = 0

  for (const member of members) {
    const meters = Number(member.meters)
    if (!member.tags || !Number.isFinite(meters) || meters <= 0)
      continue
    known += meters
    if (isStreetWay(member.tags))
      street += meters
  }

  return known > 0 ? street / known : null
}

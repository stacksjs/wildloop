import { Seeder } from '@stacksjs/database'
import Trail from '../../app/Models/Trail'

/**
 * The trail catalog a staging environment browses.
 *
 * This used to be `factory.generate(Trail, { count: 20 })`, which stopped
 * working when `factory` was removed from @stacksjs/database — so the catalog
 * was simply empty, and with it the explore page, the region breakdown, every
 * trail detail page, and the review and saved-trail surfaces that hang off a
 * trail id.
 *
 * Faker would not have been the right replacement either. Trail rows carry
 * geography — country, region, bounding box, centroid — and the explore page
 * groups by it. Random `faker.location` output puts a "Bavaria" trail in the
 * Pacific and makes the region filter look broken when it is working, exactly
 * the failure UserSeeder's note describes for names on a leaderboard.
 *
 * These are real trails, with coordinates, distances and climb figures that
 * are close enough to the published ones to be recognisable, attributed to the
 * agency that actually manages them. Derived columns (bounding box, estimated
 * time) are computed rather than typed, so they cannot disagree with the
 * numbers beside them.
 *
 * Ratings and review counts are deliberately NOT set here: they are
 * denormalized counters over `trail_reviews`, and ReviewSeeder recomputes them
 * from the reviews it writes. Seeding them by hand is how they drift.
 *
 * Idempotent on (source, source_id), which is the unique index the ingest
 * itself upserts against — re-seeding refreshes a trail rather than inserting
 * a second copy of it.
 */

type Difficulty = 'easy' | 'moderate' | 'hard'
type RouteType = 'loop' | 'out-and-back' | 'point-to-point' | 'network'
type Source = 'osm' | 'usfs' | 'nps' | 'manual'

interface SeedTrail {
  name: string
  location: string
  /** Miles. */
  distance: number
  /** Total climb, feet. */
  elevation: number
  /** Highest point, feet. */
  elevationHigh: number
  difficulty: Difficulty
  latitude: number
  longitude: number
  country: string
  state: string
  stateName: string
  managedBy: string
  routeType: RouteType
  surface: string
  allowedUses: string
  dogsAllowed: boolean
  wheelchairAccessible: boolean
  nationalTrail: boolean
  tags: string[]
  description: string
  source: Source
  sourceId: string
  sourceUrl: string
}

const TRAILS: SeedTrail[] = [
  // ---- Colorado -----------------------------------------------------------
  {
    name: 'Emerald Lake Trail',
    location: 'Estes Park, CO',
    distance: 3.2,
    elevation: 700,
    elevationHigh: 10110,
    difficulty: 'moderate',
    latitude: 40.3097,
    longitude: -105.6459,
    country: 'US',
    state: 'CO',
    stateName: 'Colorado',
    managedBy: 'Rocky Mountain National Park',
    routeType: 'out-and-back',
    surface: 'dirt',
    allowedUses: 'hiking,running',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['views', 'summit', 'wildlife'],
    description: 'Three alpine lakes on one short climb out of Bear Lake, finishing under the face of Hallett Peak.',
    source: 'nps',
    sourceId: 'romo-emerald-lake',
    sourceUrl: 'https://www.nps.gov/romo/planyourvisit/bearlakehikes.htm',
  },
  {
    name: 'Sky Pond via Glacier Gorge',
    location: 'Estes Park, CO',
    distance: 9.0,
    elevation: 1780,
    elevationHigh: 10900,
    difficulty: 'hard',
    latitude: 40.3106,
    longitude: -105.6403,
    country: 'US',
    state: 'CO',
    stateName: 'Colorado',
    managedBy: 'Rocky Mountain National Park',
    routeType: 'out-and-back',
    surface: 'dirt',
    allowedUses: 'hiking',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['waterfall', 'views', 'summit'],
    description: 'Past Alberta Falls and The Loch, then a scramble up beside Timberline Falls to a cirque under the Sharkstooth.',
    source: 'nps',
    sourceId: 'romo-sky-pond',
    sourceUrl: 'https://www.nps.gov/romo/planyourvisit/glaciergorgehikes.htm',
  },
  {
    name: 'Maroon Lake Scenic Trail',
    location: 'Aspen, CO',
    distance: 1.9,
    elevation: 120,
    elevationHigh: 9680,
    difficulty: 'easy',
    latitude: 39.0985,
    longitude: -106.9403,
    country: 'US',
    state: 'CO',
    stateName: 'Colorado',
    managedBy: 'White River National Forest',
    routeType: 'loop',
    surface: 'gravel',
    allowedUses: 'hiking,running',
    dogsAllowed: true,
    wheelchairAccessible: true,
    nationalTrail: false,
    tags: ['views', 'family', 'accessible'],
    description: 'A flat lap of Maroon Lake with the Bells straight ahead the whole way round. Timed entry in season.',
    source: 'usfs',
    sourceId: 'whiteriver-maroon-lake',
    sourceUrl: 'https://www.fs.usda.gov/recarea/whiteriver/recarea/?recid=42783',
  },
  {
    name: 'Hanging Lake Trail',
    location: 'Glenwood Springs, CO',
    distance: 2.4,
    elevation: 1000,
    elevationHigh: 7320,
    difficulty: 'hard',
    latitude: 39.6013,
    longitude: -107.1922,
    country: 'US',
    state: 'CO',
    stateName: 'Colorado',
    managedBy: 'White River National Forest',
    routeType: 'out-and-back',
    surface: 'dirt',
    allowedUses: 'hiking',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['waterfall', 'views'],
    description: 'A steep mile and a bit up a boulder-strewn creek bed to a travertine lake. Permit required.',
    source: 'usfs',
    sourceId: 'whiteriver-hanging-lake',
    sourceUrl: 'https://www.fs.usda.gov/recarea/whiteriver/recarea/?recid=41058',
  },

  // ---- California ---------------------------------------------------------
  {
    name: 'Mist Trail to Vernal Fall',
    location: 'Yosemite Valley, CA',
    distance: 2.4,
    elevation: 1000,
    elevationHigh: 5040,
    difficulty: 'moderate',
    latitude: 37.7327,
    longitude: -119.5580,
    country: 'US',
    state: 'CA',
    stateName: 'California',
    managedBy: 'Yosemite National Park',
    routeType: 'out-and-back',
    surface: 'dirt',
    allowedUses: 'hiking',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['waterfall', 'views'],
    description: 'Six hundred granite steps through the spray of Vernal Fall. Expect to get wet in spring.',
    source: 'nps',
    sourceId: 'yose-mist-vernal',
    sourceUrl: 'https://www.nps.gov/yose/planyourvisit/vernalfall.htm',
  },
  {
    name: 'Half Dome via the Mist Trail',
    location: 'Yosemite Valley, CA',
    distance: 14.2,
    elevation: 5250,
    elevationHigh: 8840,
    difficulty: 'hard',
    latitude: 37.7459,
    longitude: -119.5332,
    country: 'US',
    state: 'CA',
    stateName: 'California',
    managedBy: 'Yosemite National Park',
    routeType: 'out-and-back',
    surface: 'dirt',
    allowedUses: 'hiking',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['summit', 'views'],
    description: 'The full day out of the valley, finishing on the cables. Permit required for the subdome and cables.',
    source: 'nps',
    sourceId: 'yose-half-dome',
    sourceUrl: 'https://www.nps.gov/yose/planyourvisit/halfdome.htm',
  },
  {
    name: 'Dipsea Trail',
    location: 'Mill Valley, CA',
    distance: 7.4,
    elevation: 2200,
    elevationHigh: 1360,
    difficulty: 'hard',
    latitude: 37.8916,
    longitude: -122.5460,
    country: 'US',
    state: 'CA',
    stateName: 'California',
    managedBy: 'Mount Tamalpais State Park',
    routeType: 'point-to-point',
    surface: 'dirt',
    allowedUses: 'hiking,running',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['running', 'coastal', 'forest'],
    description: 'Mill Valley to Stinson Beach over the shoulder of Mount Tam. The oldest trail race in America runs it.',
    source: 'osm',
    sourceId: 'osm-relation-2698343',
    sourceUrl: 'https://www.openstreetmap.org/relation/2698343',
  },
  {
    name: 'Matt Davis – Steep Ravine Loop',
    location: 'Stinson Beach, CA',
    distance: 7.4,
    elevation: 1700,
    elevationHigh: 1480,
    difficulty: 'moderate',
    latitude: 37.9060,
    longitude: -122.6270,
    country: 'US',
    state: 'CA',
    stateName: 'California',
    managedBy: 'Mount Tamalpais State Park',
    routeType: 'loop',
    surface: 'dirt',
    allowedUses: 'hiking,running',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['coastal', 'forest', 'waterfall'],
    description: 'Up the open coastal side, back down a redwood creek with a ladder in it. The classic Tam loop.',
    source: 'osm',
    sourceId: 'osm-way-24417702',
    sourceUrl: 'https://www.openstreetmap.org/way/24417702',
  },
  {
    name: 'Lands End Trail',
    location: 'San Francisco, CA',
    distance: 3.4,
    elevation: 290,
    elevationHigh: 250,
    difficulty: 'easy',
    latitude: 37.7800,
    longitude: -122.5060,
    country: 'US',
    state: 'CA',
    stateName: 'California',
    managedBy: 'Golden Gate National Recreation Area',
    routeType: 'out-and-back',
    surface: 'gravel',
    allowedUses: 'hiking,running',
    dogsAllowed: true,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['coastal', 'views', 'dog-friendly'],
    description: 'Cliff-top path above the Golden Gate, with the shipwrecks visible at low tide.',
    source: 'nps',
    sourceId: 'goga-lands-end',
    sourceUrl: 'https://www.nps.gov/goga/planyourvisit/landsend.htm',
  },

  // ---- Washington ---------------------------------------------------------
  {
    name: 'Skyline Loop Trail',
    location: 'Paradise, WA',
    distance: 5.5,
    elevation: 1700,
    elevationHigh: 7000,
    difficulty: 'hard',
    latitude: 46.7860,
    longitude: -121.7350,
    country: 'US',
    state: 'WA',
    stateName: 'Washington',
    managedBy: 'Mount Rainier National Park',
    routeType: 'loop',
    surface: 'dirt',
    allowedUses: 'hiking',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['summit', 'views', 'wildlife'],
    description: 'Out of Paradise to Panorama Point and back down past Myrtle Falls. Snow on the upper half into July.',
    source: 'nps',
    sourceId: 'mora-skyline-loop',
    sourceUrl: 'https://www.nps.gov/mora/planyourvisit/paradise-area-trails.htm',
  },
  {
    name: 'Rattlesnake Ledge',
    location: 'North Bend, WA',
    distance: 4.0,
    elevation: 1160,
    elevationHigh: 2020,
    difficulty: 'moderate',
    latitude: 47.4348,
    longitude: -121.7700,
    country: 'US',
    state: 'WA',
    stateName: 'Washington',
    managedBy: 'Mountains to Sound Greenway Trust',
    routeType: 'out-and-back',
    surface: 'dirt',
    allowedUses: 'hiking,running',
    dogsAllowed: true,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['views', 'forest', 'dog-friendly'],
    description: 'Switchbacks through second-growth to a ledge over Rattlesnake Lake. Busy every weekend of the year.',
    source: 'osm',
    sourceId: 'osm-way-236152387',
    sourceUrl: 'https://www.openstreetmap.org/way/236152387',
  },

  // ---- Utah ---------------------------------------------------------------
  {
    name: 'Angels Landing',
    location: 'Springdale, UT',
    distance: 4.4,
    elevation: 1500,
    elevationHigh: 5790,
    difficulty: 'hard',
    latitude: 37.2690,
    longitude: -112.9490,
    country: 'US',
    state: 'UT',
    stateName: 'Utah',
    managedBy: 'Zion National Park',
    routeType: 'out-and-back',
    surface: 'paved',
    allowedUses: 'hiking',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['summit', 'views'],
    description: 'Walter\'s Wiggles, then a chained ridge with a drop on both sides. Permit required by lottery.',
    source: 'nps',
    sourceId: 'zion-angels-landing',
    sourceUrl: 'https://www.nps.gov/zion/planyourvisit/angels-landing-hiking-permits.htm',
  },
  {
    name: 'Delicate Arch Trail',
    location: 'Moab, UT',
    distance: 3.2,
    elevation: 630,
    elevationHigh: 4830,
    difficulty: 'moderate',
    latitude: 38.7356,
    longitude: -109.5203,
    country: 'US',
    state: 'UT',
    stateName: 'Utah',
    managedBy: 'Arches National Park',
    routeType: 'out-and-back',
    surface: 'dirt',
    allowedUses: 'hiking',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['views', 'family'],
    description: 'Open slickrock with no shade at all, ending on the rim of a bowl with the arch on the far side.',
    source: 'nps',
    sourceId: 'arch-delicate-arch',
    sourceUrl: 'https://www.nps.gov/arch/planyourvisit/delicatearch.htm',
  },
  {
    name: 'Navajo Loop and Queen\'s Garden',
    location: 'Bryce Canyon, UT',
    distance: 2.9,
    elevation: 620,
    elevationHigh: 8020,
    difficulty: 'moderate',
    latitude: 37.6250,
    longitude: -112.1650,
    country: 'US',
    state: 'UT',
    stateName: 'Utah',
    managedBy: 'Bryce Canyon National Park',
    routeType: 'loop',
    surface: 'dirt',
    allowedUses: 'hiking',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['views', 'family'],
    description: 'Down Wall Street between the hoodoos and back up through Queen\'s Garden. Walk it counter-clockwise.',
    source: 'nps',
    sourceId: 'brca-navajo-queens',
    sourceUrl: 'https://www.nps.gov/brca/planyourvisit/dayhikes.htm',
  },

  // ---- Arizona ------------------------------------------------------------
  {
    name: 'Bright Angel Trail to Three-Mile Resthouse',
    location: 'Grand Canyon Village, AZ',
    distance: 6.0,
    elevation: 2120,
    elevationHigh: 6850,
    difficulty: 'hard',
    latitude: 36.0575,
    longitude: -112.1436,
    country: 'US',
    state: 'AZ',
    stateName: 'Arizona',
    managedBy: 'Grand Canyon National Park',
    routeType: 'out-and-back',
    surface: 'dirt',
    allowedUses: 'hiking,horse',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['views'],
    description: 'The descent is the easy half. Turn round at the resthouse and budget twice as long to climb out.',
    source: 'nps',
    sourceId: 'grca-bright-angel',
    sourceUrl: 'https://www.nps.gov/grca/planyourvisit/bright-angel-trail.htm',
  },

  // ---- Oregon -------------------------------------------------------------
  {
    name: 'Multnomah–Wahkeena Falls Loop',
    location: 'Bridal Veil, OR',
    distance: 4.9,
    elevation: 1600,
    elevationHigh: 1620,
    difficulty: 'moderate',
    latitude: 45.5762,
    longitude: -122.1158,
    country: 'US',
    state: 'OR',
    stateName: 'Oregon',
    managedBy: 'Columbia River Gorge National Scenic Area',
    routeType: 'loop',
    surface: 'paved',
    allowedUses: 'hiking,running',
    dogsAllowed: true,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['waterfall', 'forest', 'dog-friendly'],
    description: 'Six named waterfalls in five miles, linking the two busiest trailheads in the Gorge.',
    source: 'usfs',
    sourceId: 'crgnsa-multnomah-wahkeena',
    sourceUrl: 'https://www.fs.usda.gov/recarea/crgnsa/recarea/?recid=30026',
  },

  // ---- Wyoming ------------------------------------------------------------
  {
    name: 'Jenny Lake Loop',
    location: 'Moose, WY',
    distance: 7.1,
    elevation: 600,
    elevationHigh: 6970,
    difficulty: 'easy',
    latitude: 43.7500,
    longitude: -110.7220,
    country: 'US',
    state: 'WY',
    stateName: 'Wyoming',
    managedBy: 'Grand Teton National Park',
    routeType: 'loop',
    surface: 'dirt',
    allowedUses: 'hiking,running',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['views', 'wildlife', 'family'],
    description: 'A flat lap of the lake directly beneath the Cathedral Group. Add Hidden Falls from the west shore.',
    source: 'nps',
    sourceId: 'grte-jenny-lake-loop',
    sourceUrl: 'https://www.nps.gov/grte/planyourvisit/jenny.htm',
  },

  // ---- Maine --------------------------------------------------------------
  {
    name: 'Precipice Trail',
    location: 'Bar Harbor, ME',
    distance: 2.1,
    elevation: 1000,
    elevationHigh: 1058,
    difficulty: 'hard',
    latitude: 44.3490,
    longitude: -68.1870,
    country: 'US',
    state: 'ME',
    stateName: 'Maine',
    managedBy: 'Acadia National Park',
    routeType: 'loop',
    surface: 'dirt',
    allowedUses: 'hiking',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['summit', 'coastal', 'views'],
    description: 'Iron rungs and ladders straight up the east face of Champlain. Closed in spring for nesting falcons.',
    source: 'nps',
    sourceId: 'acad-precipice',
    sourceUrl: 'https://www.nps.gov/acad/planyourvisit/hiking.htm',
  },

  // ---- New York -----------------------------------------------------------
  {
    name: 'Breakneck Ridge Trail',
    location: 'Cold Spring, NY',
    distance: 3.7,
    elevation: 1400,
    elevationHigh: 1250,
    difficulty: 'hard',
    latitude: 41.4470,
    longitude: -73.9750,
    country: 'US',
    state: 'NY',
    stateName: 'New York',
    managedBy: 'Hudson Highlands State Park Preserve',
    routeType: 'loop',
    surface: 'dirt',
    allowedUses: 'hiking',
    dogsAllowed: true,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['views', 'summit', 'dog-friendly'],
    description: 'A hands-on scramble out of the Hudson, reachable by train from Grand Central. Start early.',
    source: 'osm',
    sourceId: 'osm-way-42104432',
    sourceUrl: 'https://www.openstreetmap.org/way/42104432',
  },

  // ---- Tennessee ----------------------------------------------------------
  {
    name: 'Alum Cave Trail to Mount LeConte',
    location: 'Gatlinburg, TN',
    distance: 11.0,
    elevation: 2760,
    elevationHigh: 6593,
    difficulty: 'hard',
    latitude: 35.6280,
    longitude: -83.4510,
    country: 'US',
    state: 'TN',
    stateName: 'Tennessee',
    managedBy: 'Great Smoky Mountains National Park',
    routeType: 'out-and-back',
    surface: 'dirt',
    allowedUses: 'hiking',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['summit', 'forest', 'views'],
    description: 'Arch Rock, the bluffs, then cable-handrail ledges to the third-highest summit in the east.',
    source: 'nps',
    sourceId: 'grsm-alum-cave',
    sourceUrl: 'https://www.nps.gov/grsm/planyourvisit/hiking.htm',
  },
  {
    name: 'Appalachian Trail: Clingmans Dome to Newfound Gap',
    location: 'Great Smoky Mountains, TN',
    distance: 15.6,
    elevation: 1900,
    elevationHigh: 6643,
    difficulty: 'hard',
    latitude: 35.5628,
    longitude: -83.4985,
    country: 'US',
    state: 'TN',
    stateName: 'Tennessee',
    managedBy: 'Great Smoky Mountains National Park',
    routeType: 'point-to-point',
    surface: 'dirt',
    allowedUses: 'hiking',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: true,
    tags: ['summit', 'forest', 'views'],
    description: 'The ridgeline section of the AT over the highest point on the whole trail. Shuttle one end.',
    source: 'nps',
    sourceId: 'grsm-at-clingmans-newfound',
    sourceUrl: 'https://www.nps.gov/grsm/planyourvisit/at.htm',
  },

  // ---- Germany ------------------------------------------------------------
  {
    name: 'Partnachklamm Rundweg',
    location: 'Garmisch-Partenkirchen, Bayern',
    distance: 4.6,
    elevation: 700,
    elevationHigh: 3280,
    difficulty: 'moderate',
    latitude: 47.4780,
    longitude: 11.1200,
    country: 'DE',
    state: 'DE-BY',
    stateName: 'Bayern',
    managedBy: 'Markt Garmisch-Partenkirchen',
    routeType: 'loop',
    surface: 'gravel',
    allowedUses: 'hiking,running',
    dogsAllowed: true,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['waterfall', 'views', 'dog-friendly'],
    description: 'Through the gorge on galleries cut into the rock, back over the Eisernes Brücke. Entry fee at the mouth.',
    source: 'osm',
    sourceId: 'osm-way-27204418',
    sourceUrl: 'https://www.openstreetmap.org/way/27204418',
  },
  {
    name: 'Höllentalklamm',
    location: 'Grainau, Bayern',
    distance: 8.1,
    elevation: 2700,
    elevationHigh: 4360,
    difficulty: 'hard',
    latitude: 47.4560,
    longitude: 11.0700,
    country: 'DE',
    state: 'DE-BY',
    stateName: 'Bayern',
    managedBy: 'Deutscher Alpenverein',
    routeType: 'out-and-back',
    surface: 'dirt',
    allowedUses: 'hiking',
    dogsAllowed: false,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['waterfall', 'views'],
    description: 'The wet way into the Zugspitze massif: tunnels, spray and a hut at the top of the gorge.',
    source: 'osm',
    sourceId: 'osm-way-25848873',
    sourceUrl: 'https://www.openstreetmap.org/way/25848873',
  },

  // ---- Austria ------------------------------------------------------------
  {
    name: 'Seebensee über die Ehrwalder Alm',
    location: 'Ehrwald, Tirol',
    distance: 7.5,
    elevation: 1900,
    elevationHigh: 5610,
    difficulty: 'moderate',
    latitude: 47.3930,
    longitude: 10.9490,
    country: 'AT',
    state: 'AT-7',
    stateName: 'Tirol',
    managedBy: 'Tiroler Zugspitz Arena',
    routeType: 'loop',
    surface: 'gravel',
    allowedUses: 'hiking,running',
    dogsAllowed: true,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['views', 'dog-friendly'],
    description: 'Up past the alm to a green lake with the Zugspitze reflected in it. Cable car shortens the climb.',
    source: 'osm',
    sourceId: 'osm-way-38155610',
    sourceUrl: 'https://www.openstreetmap.org/way/38155610',
  },

  // ---- Switzerland --------------------------------------------------------
  {
    name: 'Oeschinensee Panoramaweg',
    location: 'Kandersteg, Bern',
    distance: 5.6,
    elevation: 1300,
    elevationHigh: 6430,
    difficulty: 'moderate',
    latitude: 46.4990,
    longitude: 7.7290,
    country: 'CH',
    state: 'CH-BE',
    stateName: 'Bern',
    managedBy: 'Gemeinde Kandersteg',
    routeType: 'loop',
    surface: 'gravel',
    allowedUses: 'hiking,running',
    dogsAllowed: true,
    wheelchairAccessible: false,
    nationalTrail: false,
    tags: ['views', 'family', 'dog-friendly'],
    description: 'A high traverse above the lake with the Blüemlisalp opposite, dropping back to the shore at the end.',
    source: 'osm',
    sourceId: 'osm-way-33218840',
    sourceUrl: 'https://www.openstreetmap.org/way/33218840',
  },
]

/**
 * The bounding box a trail of this length occupies around its centroid.
 *
 * Derived rather than typed so it always agrees with the distance beside it.
 * The catalog stores a single point per trail (the sources give a centroid,
 * not a track), and the bbox index is what "trails near me" and the territory
 * engine prefilter on — a box scaled to the route's own length is the honest
 * approximation of its extent, and never smaller than the point itself.
 */
function boundsFor(latitude: number, longitude: number, distanceMiles: number) {
  // Half the route length, as a radius, in degrees. An out-and-back covers
  // half its distance as ground, so this errs on the generous side for loops.
  const radiusMiles = Math.max(distanceMiles / 4, 0.25)
  const latSpan = radiusMiles / 69
  const lngSpan = latSpan / Math.max(Math.cos(latitude * Math.PI / 180), 0.01)
  return {
    min_lat: Number((latitude - latSpan).toFixed(6)),
    max_lat: Number((latitude + latSpan).toFixed(6)),
    min_lng: Number((longitude - lngSpan).toFixed(6)),
    max_lng: Number((longitude + lngSpan).toFixed(6)),
  }
}

/** `Xh Ym`, from Naismith's rule: 3mph on the flat plus an hour per 2000ft. */
function estimatedTime(distanceMiles: number, elevationFeet: number): string {
  const minutes = Math.round((distanceMiles / 3) * 60 + (elevationFeet / 2000) * 60)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours > 0 ? `${hours}h ${String(rest).padStart(2, '0')}m` : `${rest}m`
}

/**
 * Seed `sourceId` → the id of the trail row that actually represents it.
 *
 * Dependent seeders (activities, reviews, saved trails) refer to trails by the
 * source id declared in this file. That is only a real key when this seeder
 * inserted the row; where it adopted the catalog's own copy instead, the id
 * lives here and nowhere else. Seeders run in one process, in order, so a
 * module-level map is the whole mechanism.
 */
export const trailIdBySeedSourceId = new Map<string, number>()

/**
 * Rows THIS seeder created on an earlier run that the catalog has since made
 * redundant.
 *
 * An environment seeded before the ingest arrived carries a seeded copy of
 * every trail in this file — no geometry, so it draws nothing on a map — and
 * the ingest later added the real one beside it. Matching on (source,
 * source_id) finds the seeder's own copy first and never notices, which is how
 * production ended up with 25 duplicates and a feed whose cards could not draw
 * a route.
 *
 * Keyed by the redundant row's id, valued by the id of the ingested row that
 * replaces it. TrailDuplicateCleanupSeeder uses the pair to move anything
 * pointing at the old row onto the real one before removing it.
 */
export const supersededTrailIds = new Map<number, number>()

/**
 * Metres of slack around a seed's point when testing it against a candidate
 * trail's bounding box. Covers a trailhead marked just off the line itself.
 */
const SAME_TRAIL_METRES = 2000

/** Lowercased, punctuation folded, diacritics stripped — for comparing names. */
function foldName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036F]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * The OSM object a seeded id refers to, in the ingest's spelling.
 *
 * This file writes `osm-way-25848873`; the ingest writes `way/25848873`. The
 * same object, spelled two ways — so this is a rename, not a guess, and it is
 * the most reliable match available for anything that came from OSM.
 */
function ingestOsmId(sourceId: string): string | null {
  const match = sourceId.match(/^osm-(way|relation|node)-(\d+)$/)
  return match ? `${match[1]}/${match[2]}` : null
}

/** Rows are ranked by how much geometry they carry — the point is a drawable line. */
function richest(candidates: any[]): any | null {
  const drawable = candidates.filter(row => typeof row.geometry === 'string' && row.geometry.length > 2)
  const pool = drawable.length > 0 ? drawable : candidates
  return pool.sort((a, b) => String(b.geometry ?? '').length - String(a.geometry ?? '').length)[0] ?? null
}

/**
 * The catalog's own row for a seeded trail, if it has one.
 *
 * Three rules, in descending order of confidence, and nothing looser:
 *
 *  1. The same OSM object under the ingest's spelling of its id. Exact.
 *  2. The same name in the same region. Exact.
 *  3. The same region, the seed's point inside the candidate's extent, and
 *     one name containing the other — "Alum Cave Trail" for this file's
 *     "Alum Cave Trail to Mount LeConte".
 *
 * Rule 3 is the only one doing any inference, and all three of its conditions
 * have to hold at once. That matters: "Lands End Trail" is in California here
 * and the catalog also holds four Colorado snowmobile routes called "Lands
 * End …", which the region check alone excludes. Where nothing satisfies it —
 * the Appalachian Trail section this file names is in TN, and the nearest
 * catalog match is a different path called "Clingmans Dome Bypass Trail" in
 * NC — the answer is no match, and the seeded row stands on its own.
 */
async function findIngestedTrail(seed: SeedTrail): Promise<any | null> {
  const osmId = seed.source === 'osm' ? ingestOsmId(seed.sourceId) : null
  if (osmId) {
    const byOsmId = await Trail.where('source_id', '=', osmId).first().catch(() => null)
    if (byOsmId)
      return byOsmId
  }

  const sameName = await Trail
    .where('name', '=', seed.name)
    .where('state', '=', seed.state)
    .where('source_id', '!=', seed.sourceId)
    .get()
    .catch(() => [])

  const exact = richest(sameName as any[])
  if (exact)
    return exact

  /*
   * Rule 3, against the candidate's EXTENT rather than its centre.
   *
   * A trail is a line, and one representative point says little about where
   * it runs. "Sky Pond via Glacier Gorge" is named for its trailhead and this
   * file records that; the catalog records the pond at the far end. The same
   * nine-mile path, 2.3km apart as points, so a centre-to-centre test rejected
   * it — and widening that test would start matching genuinely different
   * trails in dense areas.
   *
   * Every ingested trail carries a bounding box (`trails_bbox_index` exists
   * for exactly this). Asking whether the seed's point lies within a candidate
   * trail's extent is both stricter in dense areas and more forgiving along a
   * long route, which is the right shape for the question.
   *
   * The box is a range scan over that index rather than a filter in
   * JavaScript: loading a region and sifting it here would pull tens of
   * thousands of rows with their geometry, twenty-five times over.
   */
  const slack = SAME_TRAIL_METRES / 111_320
  const lngSlack = slack / Math.max(0.15, Math.cos((seed.latitude * Math.PI) / 180))

  const overlapping = (await Trail
    .where('state', '=', seed.state)
    .where('source_id', '!=', seed.sourceId)
    .where('min_lat', '<=', seed.latitude + slack)
    .where('max_lat', '>=', seed.latitude - slack)
    .where('min_lng', '<=', seed.longitude + lngSlack)
    .where('max_lng', '>=', seed.longitude - lngSlack)
    .get()
    .catch(() => [])) as any[]

  const seedName = foldName(seed.name)
  const near = overlapping.filter((row) => {
    const rowName = foldName(String(row.name ?? ''))
    // A name of one or two words matches far too much. "Sky Pond" inside "Sky
    // Pond via Glacier Gorge" is the case worth having; a row called "Trail"
    // inside anything is not.
    if (rowName.length < 4)
      return false

    return seedName.includes(rowName) || rowName.includes(seedName)
  })

  return richest(near)
}

export default class TrailSeeder extends Seeder {
  // Before anything that hangs off a trail id: activities, reviews, saved
  // trails and the territories claimed on them.
  static override order = -92

  async run(): Promise<void> {
    let adopted = 0

    const syncedAt = new Date().toISOString()

    for (const seed of TRAILS) {
      const bounds = boundsFor(seed.latitude, seed.longitude, seed.distance)

      const payload = {
        name: seed.name,
        location: seed.location,
        distance: seed.distance,
        elevation: seed.elevation,
        difficulty: seed.difficulty,
        estimated_time: estimatedTime(seed.distance, seed.elevation),
        // No photography ships with the seed catalog. The views already fall
        // back to a stock image for a trail without one, so an empty string is
        // the truthful value here rather than a URL that 404s.
        image: '',
        tags: seed.tags.join(','),
        latitude: seed.latitude,
        longitude: seed.longitude,
        description: seed.description,
        geometry: '',
        source: seed.source,
        source_id: seed.sourceId,
        source_url: seed.sourceUrl,
        synced_at: syncedAt,
        country: seed.country,
        state: seed.state,
        state_name: seed.stateName,
        managed_by: seed.managedBy,
        route_type: seed.routeType,
        surface: seed.surface,
        elevation_high: seed.elevationHigh,
        allowed_uses: seed.allowedUses,
        dogs_allowed: seed.dogsAllowed,
        wheelchair_accessible: seed.wheelchairAccessible,
        national_trail: seed.nationalTrail,
        ...bounds,
      }

      // (source, source_id) is the ingest's own unique index, so re-seeding
      // refreshes the row the same way a re-sync would.
      const existing = await Trail
        .where('source', '=', seed.source)
        .where('source_id', '=', seed.sourceId)
        .first()
        .catch(() => null)

      /*
       * The catalog's own row always wins, including over this seeder's.
       *
       * These are real trails, and on any environment the national ingest has
       * run against they are ALREADY in the table — Angels Landing arrives as
       * `nps/ZION|ANGELS LANDING`, this file calls it `zion-angels-landing`.
       * Two source ids for one path, so the unique index never fires and the
       * catalog grows a twin of every seeded trail.
       *
       * Checked BEFORE the seeder's own row, not after. An environment seeded
       * once before the ingest arrived already holds that twin, and matching
       * on (source, source_id) finds it first — so the seed kept adopting its
       * own empty-geometry copy and the duplicate survived every re-seed.
       *
       * The ingested row is strictly better: it carries geometry, so it draws
       * on a map, and it is what search and the catalog pages already return.
       */
      const ingested = await findIngestedTrail(seed)

      if (ingested) {
        trailIdBySeedSourceId.set(seed.sourceId, ingested.id)
        adopted += 1
        // The seeder's own copy, if it made one before the ingest existed, is
        // now redundant. It cannot be deleted here — activities and reviews
        // still point at it until their own seeders re-point them.
        if (existing && existing.id !== ingested.id)
          supersededTrailIds.set(existing.id, ingested.id)
        continue
      }

      if (existing) {
        await Trail.forceUpdate(existing.id, payload)
        trailIdBySeedSourceId.set(seed.sourceId, existing.id)
        continue
      }

      const created = await Trail.forceCreate(payload)
      if (created?.id)
        trailIdBySeedSourceId.set(seed.sourceId, created.id)
    }

    if (adopted > 0)
      console.warn(`[seed] ${adopted} seeded trail(s) already in the catalog; used the ingested row instead of adding a duplicate`)
  }
}

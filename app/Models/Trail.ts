import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

const difficulties = ['easy', 'moderate', 'hard'] as const

/**
 * Where a trail row came from.
 *
 * Every row in this table is ingested from a public dataset rather than typed
 * in by hand, so the provenance has to travel with the row: it is what makes
 * a re-sync an UPDATE instead of a duplicate INSERT, and it is what lets us
 * attribute (and re-licence) the data correctly per source.
 *
 * - `osm`  — OpenStreetMap via Overpass (ODbL). The broadest coverage.
 * - `usfs` — USDA Forest Service EDW National Forest System Trails (public domain).
 * - `nps`  — National Park Service public trails (public domain).
 * - `manual` — created in-app.
 */
const sources = ['osm', 'usfs', 'nps', 'manual'] as const

/**
 * Shape of the trail as a route, which is what decides whether a run on it can
 * ever close a loop (and therefore claim territory).
 */
const routeTypes = ['loop', 'out-and-back', 'point-to-point', 'network'] as const

export default defineModel({
  name: 'Trail',
  table: 'trails',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'name', 'location', 'country', 'state', 'difficulty', 'rating', 'distance', 'routeType', 'source'],
      searchable: ['name', 'location', 'state', 'stateName', 'country', 'managedBy', 'tags'],
      sortable: ['createdAt', 'rating', 'distance', 'elevation', 'elevationHigh'],
      filterable: ['difficulty', 'rating', 'country', 'state', 'source', 'routeType', 'dogsAllowed', 'wheelchairAccessible', 'nationalTrail'],
    },
    useApi: {
      uri: 'trails',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

  hasMany: ['Activity', 'Review'],

  indexes: [
    // The ingest is idempotent: a re-sync of the same upstream feature has to
    // find the existing row rather than insert a second copy. `source` alone
    // is not enough (ids only unique within a source) and neither is
    // `source_id` alone (OSM way 12345 and USFS trail 12345 are unrelated).
    { name: 'trails_source_source_id_unique', columns: ['source', 'source_id'], unique: true },
    // The catalog is browsed by region far more than any other way. Region
    // codes only disambiguate within a country, so the country leads: it
    // serves "everything in Germany" and "Bayern" from the one index.
    //
    // `state_name` is carried as a third column purely to make this COVERING
    // for the region breakdown on the explore page. Grouped by
    // (country, state, state_name) against a two-column index, SQLite had to
    // fetch the name from the table for all 593,000 rows and then sort — 4.7s
    // for a query that reads 0.1s once the name is in the index itself.
    { name: 'trails_country_state_name_index', columns: ['country', 'state', 'state_name'] },
    // Kept alongside the composite because a region code is often enough on
    // its own, and a leading-column-only lookup cannot use the index above.
    { name: 'trails_state_index', columns: ['state'] },
    // Bounding-box prefilter for the territory engine, which otherwise
    // full-scans a table that is heading for millions of rows. "Near me"
    // filters on the start point instead, through `trails_lat_lng_index`
    // (migration 0000000182).
    { name: 'trails_bbox_index', columns: ['min_lat', 'max_lat', 'min_lng', 'max_lng'] },
    // Lets the ingest walk rows that have not been refreshed recently.
    { name: 'trails_synced_at_index', columns: ['synced_at'] },
    // Every explore page load sorts, and none of the sort columns were
    // indexed. At 593,000 rows `ORDER BY distance DESC LIMIT 60` planned as
    // SCAN plus a temp B-tree — sorting the entire table to return 60 rows,
    // which put the API at five to seven seconds a request.
    //
    // `national_trail` leads its own index because it is the DEFAULT sort, so
    // it runs on every first paint.
    { name: 'trails_national_trail_index', columns: ['national_trail'] },
    { name: 'trails_distance_index', columns: ['distance'] },
    // Sorting inside a country filter is the common case once more than one
    // country is in the catalog: the composite serves "longest in Germany"
    // without falling back to a sort of everything German.
    { name: 'trails_country_distance_index', columns: ['country', 'distance'] },
  ],

  attributes: {
    name: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.string().required().min(3).max(200),
        message: {
          required: 'Trail name is required',
          min: 'Trail name must have at least 3 characters',
          max: 'Trail name must have at most 200 characters',
        },
      },
      factory: faker => `${faker.location.street()} Trail`,
    },

    location: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.string().required().max(300),
        message: {
          required: 'Location is required',
        },
      },
      factory: faker => `${faker.location.city()}, ${faker.location.stateAbbr()}`,
    },

    distance: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.float().required().min(0),
        message: {
          required: 'Distance is required',
          min: 'Distance must be positive',
        },
      },
      factory: faker => faker.number.float({ min: 0.5, max: 25, fractionDigits: 1 }),
    },

    elevation: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.float().required().min(0),
        message: {
          required: 'Elevation is required',
        },
      },
      factory: faker => faker.number.int({ min: 100, max: 5000 }),
    },

    difficulty: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.enum(difficulties).required(),
        message: {
          required: 'Difficulty is required',
        },
      },
      factory: (faker): typeof difficulties[number] => faker.helpers.arrayElement([...difficulties]),
    },

    rating: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.float().min(0).max(5),
      },
      factory: faker => faker.number.float({ min: 3.5, max: 5, fractionDigits: 1 }),
    },

    reviewCount: {
      order: 7,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: faker => faker.number.int({ min: 50, max: 10000 }),
    },

    estimatedTime: {
      order: 8,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: (faker) => {
        const hours = faker.number.int({ min: 0, max: 6 })
        const mins = faker.helpers.arrayElement(['15', '30', '45', '00'])
        return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`
      },
    },

    image: {
      order: 9,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => 'https://images.unsplash.com/photo-1551632811-561732d1e306?w=800&h=600&fit=crop',
    },

    tags: {
      order: 10,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.helpers.arrayElements(['forest', 'waterfall', 'wildlife', 'coastal', 'views', 'dog-friendly', 'summit', 'running', 'family', 'accessible'], 3).join(','),
    },

    latitude: {
      order: 11,
      fillable: true,
      validation: {
        rule: schema.float(),
      },
      factory: faker => faker.location.latitude(),
    },

    longitude: {
      order: 12,
      fillable: true,
      validation: {
        rule: schema.float(),
      },
      factory: faker => faker.location.longitude(),
    },

    description: {
      order: 13,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: faker => faker.lorem.paragraphs(2),
    },

    geometry: {
      order: 14,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => '',
    },

    // ---------------------------------------------------------------------
    // Provenance. Written by the ingest, never by a user.
    // ---------------------------------------------------------------------

    source: {
      order: 15,
      fillable: true,
      default: 'manual',
      validation: {
        rule: schema.enum(sources),
      },
      factory: (): typeof sources[number] => 'manual',
    },

    /**
     * The upstream primary key, as a string because the sources disagree on
     * type: OSM uses numeric way/relation ids, USFS a `trail_cn` control
     * number, NPS a GUID-ish `GEOMETRYID`.
     */
    sourceId: {
      order: 16,
      fillable: true,
      validation: {
        rule: schema.string().max(120),
      },
      factory: faker => faker.string.uuid(),
    },

    /** Canonical upstream URL, so a trail page can credit where it came from. */
    sourceUrl: {
      order: 17,
      fillable: true,
      validation: {
        rule: schema.string().max(400),
      },
      factory: () => '',
    },

    /** Last time the ingest saw this feature upstream. Drives re-sync order. */
    syncedAt: {
      order: 18,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => new Date().toISOString(),
    },

    // ---------------------------------------------------------------------
    // Geography
    // ---------------------------------------------------------------------

    /**
     * ISO 3166-1 alpha-2, resolved from the centroid alongside the region.
     *
     * `US` for everything the Forest Service and Park Service supply; OSM adds
     * `DE`, `AT` and `CH`. Region codes are only unique within a country —
     * `BE` is both Berlin and the Swiss canton of Bern — so anything grouping
     * or filtering by region has to carry this too.
     */
    country: {
      order: 19,
      fillable: true,
      validation: {
        rule: schema.string().max(2),
      },
      factory: () => 'US',
    },

    /**
     * Region within the country, resolved from the centroid against polygons.
     *
     * Two-letter USPS code for US states (`CO`), ISO 3166-2 elsewhere
     * (`DE-BY`, `CH-ZH`) — hence six characters rather than two.
     */
    state: {
      order: 20,
      fillable: true,
      validation: {
        rule: schema.string().max(6),
      },
      factory: faker => faker.location.stateAbbr(),
    },

    stateName: {
      order: 21,
      fillable: true,
      validation: {
        rule: schema.string().max(60),
      },
      factory: faker => faker.location.state(),
    },

    /** Forest, park or district that administers the trail, when known. */
    managedBy: {
      order: 22,
      fillable: true,
      validation: {
        rule: schema.string().max(200),
      },
      factory: () => '',
    },

    minLat: {
      order: 23,
      fillable: true,
      validation: {
        rule: schema.float(),
      },
      factory: faker => faker.location.latitude(),
    },

    maxLat: {
      order: 24,
      fillable: true,
      validation: {
        rule: schema.float(),
      },
      factory: faker => faker.location.latitude(),
    },

    minLng: {
      order: 25,
      fillable: true,
      validation: {
        rule: schema.float(),
      },
      factory: faker => faker.location.longitude(),
    },

    maxLng: {
      order: 26,
      fillable: true,
      validation: {
        rule: schema.float(),
      },
      factory: faker => faker.location.longitude(),
    },

    // ---------------------------------------------------------------------
    // Trail characteristics
    // ---------------------------------------------------------------------

    routeType: {
      order: 27,
      fillable: true,
      validation: {
        rule: schema.enum(routeTypes),
      },
      factory: (faker): typeof routeTypes[number] => faker.helpers.arrayElement([...routeTypes]),
    },

    /** Normalized tread surface: dirt, gravel, paved, boardwalk, sand, snow, water. */
    surface: {
      order: 28,
      fillable: true,
      validation: {
        rule: schema.string().max(40),
      },
      factory: faker => faker.helpers.arrayElement(['dirt', 'gravel', 'paved', 'boardwalk']),
    },

    /** Highest point on the trail in feet, where the source reports it. */
    elevationHigh: {
      order: 29,
      fillable: true,
      validation: {
        rule: schema.float(),
      },
      factory: faker => faker.number.int({ min: 0, max: 14000 }),
    },

    /**
     * When the elevation gain was last measured, as opposed to what it is.
     *
     * `elevation` treats 0 as not recorded, so a genuinely flat trail cannot
     * say so through that column alone. This one separates "measured, and it
     * is flat" from "nobody has looked", which is what lets
     * `trails:repair-elevation` finish rather than re-measure a third of the
     * catalog on every run.
     */
    elevationCheckedAt: {
      order: 34,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => null,
    },

    /**
     * When the trail was last asked for a better place name than its region.
     *
     * OpenStreetMap records no place for a trail, so most of the catalog read
     * "California". The ingest and `trails:repair-locations` name a trail
     * after its park or nearest town, and some have neither near enough;
     * this separates "asked, and nothing better" from "never asked", so the
     * backfill finishes instead of asking those again every night.
     */
    locationCheckedAt: {
      order: 35,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => null,
    },

    /** Comma-separated normalized uses: hiking, running, bike, horse, ski, atv, motorcycle. */
    allowedUses: {
      order: 30,
      fillable: true,
      validation: {
        rule: schema.string().max(200),
      },
      factory: () => 'hiking,running',
    },

    dogsAllowed: {
      order: 31,
      fillable: true,
      validation: {
        rule: schema.boolean(),
      },
      factory: faker => faker.datatype.boolean(),
    },

    wheelchairAccessible: {
      order: 32,
      fillable: true,
      validation: {
        rule: schema.boolean(),
      },
      factory: () => false,
    },

    /** Part of a National Scenic/Historic Trail (PCT, AT, CDT, …). */
    nationalTrail: {
      order: 33,
      fillable: true,
      validation: {
        rule: schema.boolean(),
      },
      factory: () => false,
    },
  },

  dashboard: {
    highlight: true,
  },
})

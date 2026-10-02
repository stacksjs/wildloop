import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

const activityTypes = ['Trail Run', 'Hike', 'Walk', 'Bike'] as const
const visibilities = ['public', 'followers', 'private'] as const
const recordingSources = ['web_gps', 'native_gps', 'simulation', 'manual', 'file_import', 'garmin'] as const
const integrityStatuses = ['verified', 'unverified', 'rejected'] as const
// Kept separate from `integrityStatuses`: a rejected activity is decided, a
// flagged one is not, and conflating them either blocks honest athletes or
// waves cheats through depending on which way the conflation falls.
const reviewStates = ['none', 'pending', 'cleared', 'upheld'] as const
const gameModes = ['capture', 'free', 'none'] as const

export default defineModel({
  name: 'Activity',
  table: 'activities',
  primaryKey: 'id',
  autoIncrement: true,

  // Declared here rather than in a hand-written migration, so the schema has
  // one source. Each of these backs a query the anti-cheat path runs on every
  // upload: the duplicate-trace lookup reads by fingerprint across all
  // athletes, the history checks read one athlete's activities around a time
  // window, and the review queue reads by state.
  indexes: [
    { name: 'activities_track_fingerprint_index', columns: ['track_fingerprint'] },
    { name: 'activities_user_completed_index', columns: ['user_id', 'completed_at'] },
    { name: 'activities_review_state_index', columns: ['review_state', 'created_at'] },
  ],

  traits: {
    // The model pass seeds every model that opts in, and a framework default
    // of the same name opts in for us if this one does not — which is how
    // `buddy seed` ended up inserting the DEFAULT Activity's shape into this
    // app's table and failing on a column that only exists there. Opting in
    // for zero rows overrides that default and hands the table to the
    // application seeder in database/seeders/, which is what actually knows
    // what belongs in it.
    useSeeder: { count: 0 },
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'userId', 'trailId', 'activityType', 'distance', 'duration'],
      searchable: ['activityType'],
      sortable: ['createdAt', 'distance', 'duration'],
      filterable: ['activityType', 'userId', 'trailId'],
    },
    useApi: {
      uri: 'activities',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

  belongsTo: ['User', 'Trail'],

  attributes: {
    user_id: {
      order: 0,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
    },

    trail_id: {
      order: 0,
      fillable: true,
      validation: {
        rule: schema.number(),
      },
    },

    activity_type: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.enum(activityTypes).required(),
        message: {
          required: 'Activity type is required',
        },
      },
      factory: (faker): typeof activityTypes[number] => faker.helpers.arrayElement([...activityTypes]),
    },

    distance: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.float().required().min(0),
        message: {
          required: 'Distance is required',
        },
      },
      factory: (faker) => faker.number.float({ min: 1, max: 20, fractionDigits: 1 }),
    },

    duration: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.string().required(),
        message: {
          required: 'Duration is required',
        },
      },
      factory: (faker) => {
        const hours = faker.number.int({ min: 0, max: 4 })
        const mins = faker.number.int({ min: 0, max: 59 })
        const secs = faker.number.int({ min: 0, max: 59 })
        return hours > 0 ? `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}` : `${mins}:${secs.toString().padStart(2, '0')}`
      },
    },

    // Time actually moving (elapsed minus paused intervals, #960). `duration`
    // above is wall-clock elapsed; pace derives from moving time.
    moving_time: {
      order: 4,
      fillable: true,
      nullable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => null,
    },

    pace: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: (faker) => {
        const mins = faker.number.int({ min: 6, max: 20 })
        const secs = faker.number.int({ min: 0, max: 59 })
        return `${mins}:${secs.toString().padStart(2, '0')}`
      },
    },

    elevation: {
      order: 5,
      fillable: true,
      validation: {
        rule: schema.float().min(0),
      },
      factory: (faker) => faker.number.int({ min: 100, max: 3000 }),
    },

    kudos_count: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 0, max: 100 }),
    },

    notes: {
      order: 7,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: (faker) => faker.lorem.sentence(),
    },

    gpx_data: {
      order: 8,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => null,
    },

    // Per-mile splits computed from the GPS samples (#952), stored as a JSON
    // array of { mile, pace, elev }.
    splits: {
      order: 8,
      fillable: true,
      nullable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => null,
    },

    // Who can see this activity (#957): public (everyone), followers (the
    // owner's followers + the owner), private (owner only).
    visibility: {
      order: 9,
      fillable: true,
      validation: {
        rule: schema.enum(visibilities).required(),
      },
      factory: (): typeof visibilities[number] => 'public',
    },

    upload_id: {
      order: 10,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(100) },
      factory: () => null,
    },

    recording_source: {
      order: 11,
      fillable: true,
      validation: { rule: schema.enum(recordingSources).required() },
      factory: (): typeof recordingSources[number] => 'manual',
    },

    game_mode: {
      order: 12,
      fillable: true,
      validation: { rule: schema.enum(gameModes).required() },
      factory: (): typeof gameModes[number] => 'none',
    },

    capture_eligible: {
      order: 13,
      fillable: true,
      validation: { rule: schema.boolean() },
      factory: () => false,
    },

    integrity_status: {
      order: 14,
      fillable: true,
      validation: { rule: schema.enum(integrityStatuses).required() },
      factory: (): typeof integrityStatuses[number] => 'unverified',
    },

    integrity_reason: {
      order: 15,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    completed_at: {
      order: 16,
      fillable: true,
      validation: {
        rule: schema.string(),
      },
      factory: (faker) => faker.date.recent({ days: 30 }).toISOString(),
    },

    // Anti-cheat evidence, stored beside the verdict it produced. A reviewer
    // handling a disputed rejection needs what it was decided from, and the
    // neighbouring activity that produced a finding may since have been
    // deleted — so this is recorded rather than recomputed.
    anomaly_score: {
      order: 17,
      fillable: true,
      // A DB-level default, not just a factory: these columns are added to a
      // table that already has rows, and SQLite refuses `ADD COLUMN … NOT
      // NULL` without one.
      default: 0,
      // `float`, not `number`: this is a score between zero and one, and
      // `schema.number()` generates an INTEGER column that stores 0.6 as 0 —
      // which would leave the review queue ranking every activity the same.
      validation: { rule: schema.float().min(0).max(1) },
      factory: () => 0,
    },

    integrity_flags: {
      order: 18,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(4000) },
      factory: () => null,
    },

    track_fingerprint: {
      order: 19,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(64) },
      factory: () => null,
    },

    review_state: {
      order: 20,
      fillable: true,
      default: 'none',
      validation: { rule: schema.enum(reviewStates).required() },
      factory: (): typeof reviewStates[number] => 'none',
    },

    /*
     * Heart rate, as a summary of what an imported file carried (#1010).
     *
     * Nullable with no default, matching the migration: most activities have
     * no reading and never will, and a zero would read as a stopped heart.
     * `ActivityStoreAction` writes both on every create, so leaving them
     * undeclared here failed the whole insert — the columns existed in the
     * table and the model did not know them.
     */
    heart_rate_avg: {
      order: 21,
      fillable: true,
      nullable: true,
      validation: {
        rule: schema.number().min(20).max(250),
      },
      factory: () => null,
    },

    heart_rate_max: {
      order: 21,
      fillable: true,
      nullable: true,
      validation: {
        rule: schema.number().min(20).max(250),
      },
      factory: () => null,
    },
  },

  dashboard: {
    highlight: true,
  },
})

import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * One timed attempt at a route — the row a fastest-known-time board is built
 * from.
 *
 * This is deliberately NOT an `Activity`. An activity is "I went for a run and
 * here is the trace"; an effort is "I am claiming this time on this route,
 * under these rules, and here is why you should believe me". The two are
 * linked when the effort came from a Wildloop recording (`activity_id`), but
 * an effort can also be filed for a run recorded on somebody else's watch and
 * uploaded to Strava, which is how most records on most routes are set.
 *
 * The other reason it is its own table: an effort exists *before* it has a
 * time. An attempt announced this morning is `in_progress` with a tracker link
 * and no finish, and the tracking board is exactly that set of rows. An
 * activity, by contrast, only ever comes into being after the fact.
 *
 * The ORM is snake_case, so attribute KEYS are column names. Foreign keys are
 * plain fillable attributes rather than `belongsTo`, matching Event/Club: an
 * inline FK breaks the SQLite `migrate:fresh` ordering.
 *
 * @see resources/functions/route-records.ts for the ranking and bucketing rules
 */

const styles = ['supported', 'self_supported', 'unsupported'] as const
const categories = ['mens', 'womens', 'nonbinary'] as const
const directions = ['standard', 'reverse', 'yo_yo'] as const
const statuses = ['in_progress', 'dnf', 'pending', 'verified', 'rejected'] as const

export default defineModel({
  name: 'RouteEffort',
  table: 'route_efforts',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'trailId', 'userId', 'style', 'category', 'direction', 'status', 'elapsedSeconds', 'startedAt'],
      searchable: ['tripReport'],
      sortable: ['elapsedSeconds', 'startedAt', 'finishedAt', 'createdAt'],
      filterable: ['trailId', 'userId', 'style', 'category', 'direction', 'status'],
    },
    useApi: {
      uri: 'route-efforts',
      routes: ['index', 'show'],
    },
  },

  indexes: [
    // The trail page's board: every effort on one route, already ordered the
    // way it is ranked. Without the trailing time column SQLite reads the
    // route's rows and then sorts them, which on a popular route is the whole
    // board's cost paid on every page load.
    { name: 'route_efforts_board_index', columns: ['trail_id', 'direction', 'category', 'style', 'elapsed_seconds'] },
    // "Tracking now" and the verification queue are both a status scan with a
    // recency order, and they are the two most-polled endpoints here.
    { name: 'route_efforts_status_started_index', columns: ['status', 'started_at'] },
    // The latest-records feed, which is the records homepage.
    { name: 'route_efforts_status_finished_index', columns: ['status', 'finished_at'] },
    // An athlete's own records, on their profile.
    { name: 'route_efforts_user_index', columns: ['user_id', 'finished_at'] },
    // An effort filed from a Wildloop recording must not be filed twice, and
    // the activity page looks up its effort by the same key.
    { name: 'route_efforts_activity_index', columns: ['activity_id'] },
  ],

  attributes: {
    trail_id: {
      order: 0,
      fillable: true,
      validation: {
        rule: schema.number().required(),
        message: { required: 'A route is required' },
      },
    },

    user_id: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.number().required(),
        message: { required: 'An athlete is required' },
      },
    },

    /**
     * The Wildloop recording this effort was filed from, when there is one.
     * Null for a record set on a watch that never talked to us — which is the
     * common case for anything set before the athlete had an account.
     */
    activity_id: {
      order: 2,
      fillable: true,
      nullable: true,
      validation: { rule: schema.number() },
    },

    style: {
      order: 3,
      fillable: true,
      validation: { rule: schema.enum(styles).required() },
      factory: (): typeof styles[number] => 'self_supported',
    },

    /** Self-identified at submission, never read off the athlete's profile. */
    category: {
      order: 4,
      fillable: true,
      validation: { rule: schema.enum(categories).required() },
      factory: (): typeof categories[number] => 'mens',
    },

    direction: {
      order: 5,
      fillable: true,
      validation: { rule: schema.enum(directions).required() },
      factory: (): typeof directions[number] => 'standard',
    },

    /**
     * Runners who started and finished together. 1 is solo; anything higher
     * files the effort on the team board, because a group shares navigation,
     * pacing, and load.
     */
    team_size: {
      order: 6,
      fillable: true,
      validation: { rule: schema.number().min(1).max(20) },
      factory: () => 1,
    },

    status: {
      order: 7,
      fillable: true,
      validation: { rule: schema.enum(statuses).required() },
      factory: (): typeof statuses[number] => 'pending',
    },

    started_at: {
      order: 8,
      fillable: true,
      validation: {
        rule: schema.string().required(),
        message: { required: 'A start time is required' },
      },
      factory: faker => faker.date.recent({ days: 90 }).toISOString(),
    },

    /** Null while the attempt is still out there, and for a DNF. */
    finished_at: {
      order: 9,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /**
     * The ranked value, denormalized from the two timestamps at write time.
     *
     * Stored rather than derived because it is the sort key of every board
     * query: computing it per row would forfeit the index and turn each board
     * into a full scan of the route's history.
     */
    elapsed_seconds: {
      order: 10,
      fillable: true,
      nullable: true,
      validation: { rule: schema.number().min(0) },
      factory: (faker: any) => faker.number.int({ min: 3600, max: 200_000 }),
    },

    /** Link to the recording on the platform that holds it (Strava, Garmin…). */
    evidence_url: {
      order: 11,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /** Uploaded GPS file, when the athlete has the original rather than a link. */
    gpx_url: {
      order: 12,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /** Live tracker, read by the tracking board while the attempt is running. */
    tracker_url: {
      order: 13,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(500) },
      factory: () => null,
    },

    /**
     * The athlete's own account of the effort. Not evidence on its own, but
     * it is what makes a route page worth reading a year later, and an
     * inconsistency between the report and the trace is how most bad claims
     * are actually caught.
     */
    trip_report: {
      order: 14,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(20_000) },
      factory: faker => faker.lorem.paragraph(),
    },

    /** The admin who verified or rejected, kept so a decision has an author. */
    reviewed_by: {
      order: 15,
      fillable: true,
      nullable: true,
      validation: { rule: schema.number() },
      factory: () => null,
    },

    reviewed_at: {
      order: 16,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string() },
      factory: () => null,
    },

    /** Why it was rejected, shown to the athlete so a resubmission can fix it. */
    review_note: {
      order: 17,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(1000) },
      factory: () => null,
    },
  },

  dashboard: {
    highlight: true,
  },
})

import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A scheduled group effort: a backyard ultra, a race, a group run, a time
 * trial. The type that shapes everything else is `backyard`.
 *
 * A backyard ultra is a "last one standing" format: every runner starts the
 * same loop — a *yard* — on the hour, and has that hour to finish it and be
 * back in the corral for the next start. Miss the start and you are out. It
 * ends when one runner completes a yard nobody else does.
 *
 * Two consequences drive this schema:
 *   - Progress is counted in whole yards, not distance, so `EventLap` is the
 *     unit of record and `yard_minutes` is what turns a start time into every
 *     subsequent one.
 *   - There is no finish line to wait at, which is why the format is watched
 *     rather than attended. `status` is the switch the live page reads.
 *
 * The ORM is snake_case, so attribute KEYS are column names. FKs are plain
 * fillable attrs rather than belongsTo, matching Club/ClubMember: an inline FK
 * breaks the SQLite migrate:fresh ordering.
 */

const eventTypes = ['backyard', 'race', 'group_run', 'time_trial'] as const
const statuses = ['scheduled', 'live', 'finished', 'cancelled'] as const
const visibilities = ['public', 'club', 'private'] as const

export default defineModel({
  name: 'Event',
  table: 'events',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'name', 'location', 'eventType', 'status'],
      searchable: ['name', 'description', 'location'],
      sortable: ['startTime', 'createdAt', 'name'],
      filterable: ['eventType', 'status', 'visibility'],
    },
    useApi: {
      uri: 'events',
      routes: ['index', 'show'],
    },
  },

  indexes: [
    { name: 'events_status_start_index', columns: ['status', 'start_time'] },
    { name: 'events_club_index', columns: ['club_id'] },
  ],

  attributes: {
    host_id: {
      order: 0,
      fillable: true,
      validation: {
        rule: schema.number().required(),
        message: { required: 'Host ID is required' },
      },
    },

    club_id: {
      order: 1,
      fillable: true,
      nullable: true,
      validation: { rule: schema.number() },
    },

    trail_id: {
      order: 2,
      fillable: true,
      nullable: true,
      validation: { rule: schema.number() },
    },

    name: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.string().required().min(3).max(140),
        message: { required: 'Event name is required' },
      },
      factory: faker => `${faker.location.city()} Backyard Ultra`,
    },

    description: {
      order: 4,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(2000) },
      factory: faker => faker.lorem.sentence(),
    },

    location: {
      order: 5,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(160) },
      factory: faker => `${faker.location.city()}, ${faker.location.stateAbbr()}`,
    },

    event_type: {
      order: 6,
      fillable: true,
      validation: { rule: schema.enum(eventTypes).required() },
      factory: (): typeof eventTypes[number] => 'backyard',
    },

    status: {
      order: 7,
      fillable: true,
      validation: { rule: schema.enum(statuses).required() },
      factory: (): typeof statuses[number] => 'scheduled',
    },

    visibility: {
      order: 8,
      fillable: true,
      validation: { rule: schema.enum(visibilities).required() },
      factory: (): typeof visibilities[number] => 'public',
    },

    /** Miles per yard. The classic backyard distance is 4.167 mi (6.706 km). */
    loop_distance: {
      order: 9,
      fillable: true,
      validation: { rule: schema.float().min(0.1).max(100) },
      factory: () => 4.167,
    },

    /** JSON `[[lat,lng],…]` for the yard loop, when the host traced one. */
    loop_route: {
      order: 10,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(2_000_000) },
    },

    /**
     * Minutes between starts. 60 is the backyard standard; a shorter yard is
     * what makes a "sunrise-to-sunset" variant work, so it is a column rather
     * than a constant.
     */
    yard_minutes: {
      order: 11,
      fillable: true,
      validation: { rule: schema.number().min(5).max(720) },
      factory: () => 60,
    },

    /** ISO timestamp of yard 1's start. Every later yard derives from it. */
    start_time: {
      order: 12,
      fillable: true,
      validation: {
        rule: schema.string().required(),
        message: { required: 'A start time is required' },
      },
      factory: faker => faker.date.soon().toISOString(),
    },

    /** Optional hard stop, for a format that is capped rather than last-standing. */
    max_yards: {
      order: 13,
      fillable: true,
      nullable: true,
      validation: { rule: schema.number().min(1).max(1000) },
    },

    /** Set when the event resolves, so the winner survives a recount. */
    winner_id: {
      order: 14,
      fillable: true,
      nullable: true,
      validation: { rule: schema.number() },
    },

    /**
     * Where the event happens, so the directory can sort by distance and
     * filter by radius. `location` is the words, these are the point. Taken
     * from the trail when the event is on one; null when nobody said.
     */
    latitude: {
      order: 15,
      fillable: true,
      nullable: true,
      validation: { rule: schema.float().min(-90).max(90) },
      factory: faker => faker.location.latitude(),
    },

    longitude: {
      order: 16,
      fillable: true,
      nullable: true,
      validation: { rule: schema.float().min(-180).max(180) },
      factory: faker => faker.location.longitude(),
    },
  },

  dashboard: {
    highlight: true,
  },
})

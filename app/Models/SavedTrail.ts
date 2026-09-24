import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'SavedTrail',
  table: 'saved_trails',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useApi: {
      uri: 'saved-trails',
      routes: ['index', 'store', 'destroy'],
    },
  },

  belongsTo: ['User', 'Trail'],

  // A trail can only be saved once per user (#972).
  indexes: [
    { name: 'saved_trails_user_trail_unique', columns: ['user_id', 'trail_id'], unique: true },
  ],

  attributes: {
    // FK columns declared explicitly so ORM writes persist them (snake_case
    // contract); the columns themselves already come from belongsTo.
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

    notes: {
      order: 1,
      fillable: true,
      nullable: true,
      validation: {
        rule: schema.string().max(500),
      },
      factory: (faker) => faker.lorem.sentence(),
    },

    want_to_visit: {
      order: 2,
      fillable: true,
      validation: {
        rule: schema.boolean(),
      },
      factory: (faker) => faker.datatype.boolean(),
    },

    has_visited: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.boolean(),
      },
      factory: (faker) => faker.datatype.boolean(),
    },

    // The heart. A row can be done without being saved (marked from the
    // trail page), so saving and having been are separate flags.
    is_saved: {
      order: 4,
      fillable: true,
      default: true,
      validation: {
        rule: schema.boolean(),
      },
      factory: () => true,
    },
  },
})

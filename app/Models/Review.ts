import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

const conditions = ['excellent', 'good', 'fair', 'poor', 'muddy', 'icy'] as const

export default defineModel({
  name: 'Review',
  table: 'trail_reviews',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useSearch: {
      displayable: ['id', 'rating', 'title'],
      searchable: ['title', 'content'],
      sortable: ['createdAt', 'rating', 'helpfulCount'],
      filterable: ['rating'],
    },
    useApi: {
      uri: 'trail-reviews',
      routes: ['index', 'store', 'show', 'update', 'destroy'],
    },
  },

  belongsTo: ['User', 'Trail'],

  // One review per user per trail (#972) - the store action upserts.
  indexes: [
    { name: 'trail_reviews_user_trail_unique', columns: ['user_id', 'trail_id'], unique: true },
    // Reviews are read by trail, newest first: a trail's own reviews tab, and
    // the recent-reviewer lookup behind a page of catalog cards. The unique
    // index above leads on `user_id`, so neither could use it and both scanned
    // the table.
    { name: 'trail_reviews_trail_created_index', columns: ['trail_id', 'created_at'] },
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

    rating: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.number().required().min(1).max(5),
        message: {
          required: 'Rating is required',
          min: 'Rating must be at least 1',
          max: 'Rating must be at most 5',
        },
      },
      factory: (faker) => faker.number.int({ min: 3, max: 5 }),
    },

    title: {
      order: 2,
      fillable: true,
      nullable: true,
      validation: {
        rule: schema.string().max(200),
      },
      factory: (faker) => faker.helpers.arrayElement([
        'Amazing trail!',
        'Beautiful views',
        'Great workout',
        'Perfect for beginners',
        'Challenging but worth it',
        'Best trail in the area',
        'Highly recommend',
        'Nice and peaceful',
      ]),
    },

    content: {
      order: 3,
      fillable: true,
      validation: {
        rule: schema.string().required().min(10).max(2000),
        message: {
          required: 'Review content is required',
          min: 'Review must be at least 10 characters',
        },
      },
      factory: (faker) => faker.lorem.paragraphs(2),
    },

    visit_date: {
      order: 4,
      fillable: true,
      nullable: true,
      validation: {
        rule: schema.string(),
      },
      factory: (faker) => faker.date.recent({ days: 90 }).toISOString().split('T')[0],
    },

    conditions: {
      order: 5,
      fillable: true,
      nullable: true,
      validation: {
        rule: schema.enum(conditions),
      },
      factory: (faker): typeof conditions[number] => faker.helpers.arrayElement([...conditions]),
    },

    helpful_count: {
      order: 6,
      fillable: true,
      validation: {
        rule: schema.number().min(0),
      },
      factory: (faker) => faker.number.int({ min: 0, max: 200 }),
    },

    photos: {
      order: 7,
      fillable: true,
      nullable: true,
      validation: {
        rule: schema.string(),
      },
      factory: () => null,
    },
  },

  dashboard: {
    highlight: true,
  },
})

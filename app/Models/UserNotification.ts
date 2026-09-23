import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

// In-app notification. Named UserNotification / user_notifications to avoid the
// framework's core `Notification` model + `notifications` table. Snake_case
// attribute keys; FK columns are plain fillable attributes (no belongsTo).

// conquest_attack / conquest_defend / conquest_win match the frontend's
// notification vocabulary (icons + styling in notifications.stx).
const types = ['kudos', 'comment', 'follow', 'conquest', 'conquest_attack', 'conquest_defend', 'conquest_win', 'achievement', 'challenge', 'record', 'plan'] as const

export default defineModel({
  name: 'UserNotification',
  table: 'user_notifications',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
    useApi: {
      uri: 'user-notifications',
      routes: ['index', 'destroy'],
    },
  },

  attributes: {
    // The recipient of the notification.
    recipient_id: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.number().required(),
        message: { required: 'Recipient ID is required' },
      },
    },

    // The user who triggered it.
    actor_id: {
      order: 2,
      fillable: true,
      validation: { rule: schema.number() },
    },

    actor_name: {
      order: 3,
      fillable: true,
      validation: { rule: schema.string() },
    },

    type: {
      order: 4,
      fillable: true,
      validation: { rule: schema.enum(types) },
    },

    body: {
      order: 5,
      fillable: true,
      validation: { rule: schema.string() },
    },

    link: {
      order: 6,
      fillable: true,
      validation: { rule: schema.string() },
    },

    read: {
      order: 7,
      fillable: true,
      validation: { rule: schema.boolean() },
    },
  },
})

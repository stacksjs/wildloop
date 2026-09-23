import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * A trip someone has planned: a trail from the catalog, or any spot on the
 * map, on a day.
 *
 * The destination is copied onto the plan (`latitude`/`longitude`, `title`)
 * even when it is a trail. Directions need a point, the plan has to open
 * offline at a trailhead with no signal, and a trail renamed or removed from
 * the catalog must not take someone's trip with it.
 *
 * `planned_for` is a calendar date (YYYY-MM-DD), not an instant: "Saturday"
 * means Saturday wherever the trail is. `timezone` is where the plan was
 * made, and it is what the day-before reminder counts days in.
 */
export default defineModel({
  name: 'TripPlan',
  table: 'trip_plans',
  primaryKey: 'id',
  autoIncrement: true,
  traits: { useUuid: true, useTimestamps: true },
  belongsTo: ['User', 'Trail'],
  indexes: [
    { name: 'trip_plans_user_date_index', columns: ['user_id', 'planned_for'] },
    { name: 'trip_plans_reminder_index', columns: ['reminded_at', 'planned_for'] },
  ],
  attributes: {
    user_id: { fillable: true, validation: { rule: schema.number().required() } },
    trail_id: { fillable: true, nullable: true, validation: { rule: schema.number() } },
    title: { fillable: true, validation: { rule: schema.string().min(1).max(120).required() } },
    place_label: { fillable: true, nullable: true, validation: { rule: schema.string().max(200) } },
    latitude: { fillable: true, validation: { rule: schema.float().min(-90).max(90).required() } },
    longitude: { fillable: true, validation: { rule: schema.float().min(-180).max(180).required() } },
    planned_for: { fillable: true, validation: { rule: schema.string().max(10).required() } },
    start_time: { fillable: true, nullable: true, validation: { rule: schema.string().max(5) } },
    timezone: { fillable: true, nullable: true, validation: { rule: schema.string().max(64) } },
    activity_type: { fillable: true, nullable: true, validation: { rule: schema.string().max(20) } },
    notes: { fillable: true, nullable: true, validation: { rule: schema.string().max(1000) } },
    reminded_at: { fillable: true, nullable: true, validation: { rule: schema.string().max(40) } },
  },
} as const)

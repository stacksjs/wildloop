import { defineModel } from '@stacksjs/orm'
import { schema } from '@stacksjs/validation'

/**
 * An invitation to a closed club.
 *
 * `is_private` only ever controlled *visibility* — who could see the club in
 * the listing. A club like Rappid Run is closed in a stronger sense: seeing it
 * is fine, joining is not, unless somebody already inside asked you. That is
 * `Club.join_policy = 'invite_only'`, and this table is the record of who was
 * asked.
 *
 * An invite can name a user id (invite an athlete already on Wildloop) or an
 * email (invite somebody who has not signed up yet); the code works either
 * way, so an invite link survives the recipient creating their account after
 * receiving it.
 */

const statuses = ['pending', 'accepted', 'revoked', 'expired'] as const

export default defineModel({
  name: 'ClubInvite',
  table: 'club_invites',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    useUuid: true,
    useTimestamps: true,
  },

  indexes: [
    { name: 'club_invites_code_unique', columns: ['code'], unique: true },
    { name: 'club_invites_club_status_index', columns: ['club_id', 'status'] },
  ],

  attributes: {
    club_id: {
      order: 0,
      fillable: true,
      validation: {
        rule: schema.number().required(),
        message: { required: 'Club ID is required' },
      },
    },

    invited_by_id: {
      order: 1,
      fillable: true,
      validation: {
        rule: schema.number().required(),
        message: { required: 'An inviter is required' },
      },
    },

    /** The athlete invited, when they already have an account. */
    invited_user_id: {
      order: 2,
      fillable: true,
      nullable: true,
      validation: { rule: schema.number() },
    },

    /** The address invited, when they do not yet. */
    invited_email: {
      order: 3,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(200) },
    },

    /** The redeemable half of the invite link. Unique across all clubs. */
    code: {
      order: 4,
      fillable: true,
      validation: {
        rule: schema.string().required().min(8).max(64),
        message: { required: 'An invite code is required' },
      },
    },

    status: {
      order: 5,
      fillable: true,
      validation: { rule: schema.enum(statuses).required() },
      factory: (): typeof statuses[number] => 'pending',
    },

    /** ISO timestamp. A pending invite past this is treated as expired. */
    expires_at: {
      order: 6,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(40) },
    },

    accepted_at: {
      order: 7,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(40) },
    },

    /** A line from the person inviting. Shown on the redemption screen. */
    note: {
      order: 8,
      fillable: true,
      nullable: true,
      validation: { rule: schema.string().max(300) },
    },
  },
})

import type { Attributes } from '@stacksjs/types'
import { defineModel } from '@stacksjs/orm'
import { makeHash } from '@stacksjs/security'
import { schema } from '@stacksjs/validation'

export default defineModel({
  name: 'User',
  table: 'users',
  primaryKey: 'id',
  autoIncrement: true,

  traits: {
    // The model pass seeds every model that opts in, and a framework default
    // of the same name opts in for us if this one does not — which is how
    // `buddy seed` ended up inserting the DEFAULT User's shape into this
    // app's table and failing on a column that only exists there. Opting in
    // for zero rows overrides that default and hands the table to the
    // application seeder in database/seeders/, which is what actually knows
    // what belongs in it.
    useSeeder: { count: 0 },
    useAuth: true,
    useUuid: true,
    useTimestamps: true,
    useApi: {
      uri: 'users',
      routes: ['index', 'show'],
    },
  },

  hasMany: ['PersonalAccessToken'],

  attributes: {
    name: {
      fillable: true,
      validation: {
        rule: schema.string().required().min(2).max(100),
        message: {
          min: 'Name must have at least 2 characters',
          required: 'Name is required',
        },
      },
    },

    email: {
      unique: true,
      fillable: true,
      validation: {
        rule: schema.string().email().required(),
        message: {
          required: 'Email is required',
          email: 'Email must be a valid email address',
        },
      },
    },

    password: {
      hidden: true,
      fillable: true,
      validation: {
        rule: schema.string().required().min(6).max(255),
        message: {
          required: 'Password is required',
          min: 'Password must have at least 6 characters',
        },
      },
    },

    // The profile photo, as the URL it is served from (see
    // app/Support/avatars.ts). Written by the avatar endpoints and the
    // AvatarSeeder, which process the image first; nullable, since most
    // accounts have none and show their initial instead.
    avatar: {
      fillable: true,
      nullable: true,
      validation: {
        rule: schema.string().max(2048),
        message: {
          max: 'Avatar URL is too long',
        },
      },
    },

    bio: {
      fillable: true,
      nullable: true,
      validation: {
        rule: schema.string().max(280),
        message: {
          max: 'Bio can be up to 280 characters',
        },
      },
    },

    location: {
      fillable: true,
      nullable: true,
      validation: {
        rule: schema.string().max(80),
        message: {
          max: 'Location can be up to 80 characters',
        },
      },
    },
  },

  set: {
    password: async (attributes: Attributes) => {
      return await makeHash(attributes.password, { algorithm: 'bcrypt' })
    },
  },
} as const)

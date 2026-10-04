import type { AuthConfig } from '@stacksjs/types'

// Use direct environment variable access to avoid circular dependencies
const envVars = typeof Bun !== 'undefined' ? Bun.env : process.env

/**
 * **Authentication Configuration**
 *
 * This configuration defines all of your authentication options. Because Stacks is fully-typed,
 * you may hover any of the options below and the definitions will be provided. In case
 * you have any questions, feel free to reach out via Discord or GitHub Discussions.
 */
export default {
  enabled: true,

  // Signup should explain when an email is taken and point to account recovery.
  // Stacks otherwise replaces the duplicate-email error with a generic 422.
  registration: {
    preventEnumeration: false,
  },

  /**
   * The authentication guard to use for your application.
   */
  default: 'api',

  /**
   * The authentication guards available for your application.
   */
  guards: {
    api: {
      driver: 'token',
      provider: 'users',
    },
  },

  /**
   * The authentication providers available for your application.
   */
  providers: {
    users: {
      driver: 'database',
      table: 'users',
    },
  },

  /**
   * The username field used for authentication.
   */
  username: envVars.AUTH_USERNAME_FIELD || 'email',

  /**
   * The password field used for authentication.
   */
  password: envVars.AUTH_PASSWORD_FIELD || 'password',

  /**
   * The token expiry time in milliseconds (default: 30 days).
   */
  tokenExpiry: Number(envVars.AUTH_TOKEN_EXPIRY) || 30 * 24 * 60 * 60 * 1000,

  /**
   * Browser sign-in, where "Remember me" decides how long the session lasts.
   *
   * Without it the session is meant to be this visit: the API issues a token
   * for the working day, and the browser keeps it in session storage, so
   * closing the browser on a shared machine ends it. With it, the session
   * lasts as long as tokens ever do here.
   *
   * No refresh token: the client holds one bearer token and signs in again
   * when it expires. Nothing in Wildloop exchanges a refresh token yet, and
   * issuing one nobody redeems only widens what a stolen response is worth.
   */
  /**
   * Signing in with a provider instead of a password (#970).
   *
   * Absent credentials disable the feature rather than half-enable it: the
   * buttons stay hidden and the routes refuse, because a sign-in that opens
   * Google (or Apple) and comes back to an error is worse than one that was
   * never offered. `configured` is what the pages read. The variables, and
   * where each comes from, are in docs/wildloop/operations.md.
   */
  social: {
    google: {
      clientId: envVars.GOOGLE_CLIENT_ID || '',
      clientSecret: envVars.GOOGLE_CLIENT_SECRET || '',
      get configured(): boolean {
        return Boolean(this.clientId && this.clientSecret)
      },
    },

    /*
     * Apple issues no client secret. It issues a private key, and the secret
     * is a short-lived JWT signed with it, minted for each sign-in (see
     * app/Support/appleSignIn.ts) — so these are the four things that mint
     * one, and there is nothing to rotate. All four, or the feature is off.
     *
     * APPLE_TEAM_ID is the same team id the iOS build and the associated
     * domains file already read (config/mobile.ts).
     */
    apple: {
      clientId: envVars.APPLE_CLIENT_ID || '',
      teamId: envVars.APPLE_TEAM_ID || '',
      keyId: envVars.APPLE_KEY_ID || '',
      privateKey: envVars.APPLE_PRIVATE_KEY || '',
      get configured(): boolean {
        return Boolean(this.clientId && this.teamId && this.keyId && this.privateKey)
      },
    },
  },

  browserSession: {
    baselineLifetime: Number(envVars.AUTH_SESSION_LIFETIME) || 12 * 60 * 60 * 1000,
    rememberedLifetime: Number(envVars.AUTH_TOKEN_EXPIRY) || 30 * 24 * 60 * 60 * 1000,
    withRefreshToken: false,
  },

  /**
   * The token rotation time in hours (default: 24 hours).
   */
  tokenRotation: Number(envVars.AUTH_TOKEN_ROTATION) || 24,

  /**
   * The token abilities that are granted by default.
   */
  defaultAbilities: ['*'],

  /**
   * The token name used when creating new tokens.
   */
  defaultTokenName: 'auth-token',

  /**
   * Password reset configuration.
   */
  passwordReset: {
    /**
     * Token expiration time in minutes.
     * After this time, the reset link becomes invalid.
     *
     * @default 60
     */
    expire: Number(envVars.AUTH_PASSWORD_RESET_EXPIRE) || 60,

    /**
     * Throttle time in seconds between password reset requests.
     * Users must wait this long before requesting another reset email.
     *
     * @default 60
     */
    throttle: Number(envVars.AUTH_PASSWORD_RESET_THROTTLE) || 60,
  },
} satisfies AuthConfig

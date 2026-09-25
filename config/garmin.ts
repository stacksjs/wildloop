const envVars = typeof Bun !== 'undefined' ? Bun.env : process.env

/**
 * **Garmin Connect Developer Program**
 *
 * Watch to Wildloop, with nothing in between: a run saved on the watch syncs
 * to Garmin Connect, and Garmin pushes it to us within seconds. No polling, no
 * Garmin password, and the athlete can revoke us from their Garmin account.
 *
 * Access is granted per application by Garmin, so until the credentials exist
 * this whole feature reports itself as unconfigured rather than half-working:
 * the connect button explains what is missing instead of starting a flow that
 * cannot finish.
 *
 * Endpoints are from Garmin's OAuth 2.0 PKCE specification. PKCE matters even
 * though we hold a client secret: the authorization code is handed back
 * through the athlete's browser, and the code_verifier is what stops a code
 * intercepted there from being redeemed by anyone else.
 */
export default {
  /** Client id issued by Garmin for this application. */
  clientId: envVars.GARMIN_CLIENT_ID || '',

  /** Client secret issued by Garmin. Server-side only, never sent to a browser. */
  clientSecret: envVars.GARMIN_CLIENT_SECRET || '',

  /**
   * Where Garmin returns the athlete after they approve.
   *
   * Must match a redirect URI registered with Garmin exactly, including
   * scheme and trailing path. A mismatch fails at the consent screen with an
   * error the athlete cannot act on, so it is worth checking twice.
   */
  redirectUri: envVars.GARMIN_REDIRECT_URI || 'https://wildloop.org/api/garmin/callback',

  /**
   * Shared secret proving a webhook came from Garmin.
   *
   * The Activity API pushes to a public URL, so the endpoint has to establish
   * that a request is genuinely Garmin's before it writes anything. Until this
   * is set the webhook accepts nothing.
   */
  webhookSecret: envVars.GARMIN_WEBHOOK_SECRET || '',

  /** Activity data, read-only. We never write back to the athlete's Garmin account. */
  scope: envVars.GARMIN_SCOPE || 'ACTIVITY_EXPORT',

  endpoints: {
    authorize: 'https://connect.garmin.com/oauth2Confirm',
    token: 'https://diauth.garmin.com/di-oauth2-service/oauth/token',
    /** Exchanges an access token for Garmin's opaque user id. */
    userId: 'https://apis.garmin.com/wellness-api/rest/user/id',
    /** What the athlete has actually granted, which can be less than we asked for. */
    permissions: 'https://apis.garmin.com/wellness-api/rest/user/permissions',
    /** Ends the connection on Garmin's side when someone disconnects here. */
    deregister: 'https://apis.garmin.com/wellness-api/rest/user/registration',
  },
}

/**
 * Garmin, the WildLoop-specific parts.
 *
 * The protocol itself - PKCE, the authorize URL, reading a push payload,
 * authenticating a webhook - lives in `ts-watches`, which owns the Activity API
 * and its tests. What stays here is the part no library can know: how a Garmin
 * summary becomes a WildLoop Activity, in the units and shapes this app stores.
 *
 * Everything below is a plain function over plain data, so the conversions can
 * be tested without a Garmin account, a network, or a database.
 */

import { createPkcePair, extractActivitySummaries, extractDeregistrations, GarminActivityApiClient, isAuthenticWebhook, signState, verifyState } from 'ts-watches'

export type { GarminActivitySummary, GarminDeregistration } from 'ts-watches'
export { createPkcePair, isAuthenticWebhook }

export function createGarminClient(config: {
  clientId: string
  clientSecret: string
  redirectUri: string
  scope?: string
  endpoints?: {
    authorize?: string
    token?: string
    userId?: string
    permissions?: string
    deregister?: string
  }
}): GarminActivityApiClient {
  return new GarminActivityApiClient({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri: config.redirectUri,
    scope: config.scope,
    endpoints: {
      authorize: config.endpoints?.authorize,
      token: config.endpoints?.token,
      userId: config.endpoints?.userId,
      permissions: config.endpoints?.permissions,
      registration: config.endpoints?.deregister,
    },
  })
}

/**
 * Garmin's activity types mapped onto the four WildLoop records.
 *
 * Garmin publishes well over a hundred types, most of which are not a trail
 * activity (POOL_SWIMMING, YOGA, INDOOR_CARDIO). Mapping only what belongs
 * here, and skipping the rest, keeps someone's feed about where they went
 * rather than everything their watch happened to record.
 */
const ACTIVITY_TYPES: Record<string, string> = {
  RUNNING: 'Trail Run',
  TRAIL_RUNNING: 'Trail Run',
  TREADMILL_RUNNING: 'Trail Run',
  INDOOR_RUNNING: 'Trail Run',
  OBSTACLE_RUN: 'Trail Run',
  ULTRA_RUN: 'Trail Run',
  VIRTUAL_RUN: 'Trail Run',
  HIKING: 'Hike',
  MOUNTAINEERING: 'Hike',
  WALKING: 'Walk',
  CASUAL_WALKING: 'Walk',
  SPEED_WALKING: 'Walk',
  CYCLING: 'Bike',
  ROAD_BIKING: 'Bike',
  MOUNTAIN_BIKING: 'Bike',
  GRAVEL_CYCLING: 'Bike',
  CYCLOCROSS: 'Bike',
  INDOOR_CYCLING: 'Bike',
  VIRTUAL_RIDE: 'Bike',
}

const METERS_PER_MILE = 1609.344
const FEET_PER_METER = 3.280839895

/**
 * The WildLoop activity type for a Garmin type, or null when it is not
 * something this app records.
 *
 * Returning null rather than defaulting to 'Trail Run' is deliberate: a yoga
 * session filed as a trail run is worse than one not imported at all, because
 * it silently corrupts totals and leaderboards.
 */
export function toActivityType(garminType?: string): string | null {
  if (!garminType)
    return null
  return ACTIVITY_TYPES[garminType.toUpperCase()] ?? null
}

/** Format seconds the way the Activity model stores duration: H:MM:SS, or MM:SS under an hour. */
export function toDurationString(totalSeconds?: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds ?? 0))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const secs = seconds % 60

  if (hours > 0)
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

/**
 * Pace as MM:SS per mile.
 *
 * Returns null for a zero-distance or zero-duration activity rather than
 * Infinity or NaN, either of which would render as garbage in the feed.
 */
export function toPacePerMile(distanceMeters?: number, durationSeconds?: number): string | null {
  const miles = (distanceMeters ?? 0) / METERS_PER_MILE
  const seconds = durationSeconds ?? 0
  if (miles <= 0 || seconds <= 0)
    return null

  const perMile = Math.round(seconds / miles)
  // A pace beyond ~99 minutes per mile is a stopped watch, not a walk.
  if (perMile > 99 * 60)
    return null

  return `${Math.floor(perMile / 60)}:${String(perMile % 60).padStart(2, '0')}`
}

export interface MappedActivity {
  activity_type: string
  distance: number
  duration: string
  moving_time: string | null
  pace: string | null
  elevation: number
  notes: string | null
  completed_at: string
  visibility: string
}

/**
 * Turn a Garmin summary into the row the Activity model expects, or null when
 * the activity is not one WildLoop records.
 *
 * Units are converted here because the model stores miles and feet (matching
 * what the UI labels), while Garmin reports metres throughout. Getting that
 * backwards would not error anywhere - it would just quietly log a 5 km run as
 * a 5 mile one.
 */
export function mapActivity(summary: GarminActivitySummary): MappedActivity | null {
  const activityType = toActivityType(summary.activityType)
  if (!activityType)
    return null

  // A multisport parent duplicates distance already counted by its children.
  if (summary.isParent)
    return null

  const durationSeconds = summary.durationInSeconds ?? 0
  const distanceMeters = summary.distanceInMeters ?? 0

  const startSeconds = summary.startTimeInSeconds ?? 0
  // Garmin timestamps are UTC with the local offset alongside. Record the
  // moment it finished, in UTC, so activities from a trip abroad still sort
  // correctly against the ones at home.
  const completedAt = new Date((startSeconds + durationSeconds) * 1000)

  const notes = [
    summary.activityName,
    summary.deviceName ? `Recorded on ${summary.deviceName}` : null,
    summary.averageHeartRateInBeatsPerMinute ? `Avg HR ${summary.averageHeartRateInBeatsPerMinute} bpm` : null,
  ].filter(Boolean).join(' · ') || null

  return {
    activity_type: activityType,
    distance: Number((distanceMeters / METERS_PER_MILE).toFixed(2)),
    duration: toDurationString(durationSeconds),
    moving_time: durationSeconds > 0 ? toDurationString(durationSeconds) : null,
    pace: toPacePerMile(distanceMeters, durationSeconds),
    elevation: Math.round((summary.totalElevationGainInMeters ?? 0) * FEET_PER_METER),
    notes,
    completed_at: completedAt.toISOString(),
    // Imports are private until the athlete decides otherwise. A sync that
    // silently publishes someone's movements to a public feed is not a
    // default anyone would choose.
    visibility: 'private',
  }
}

/**
 * Build the URL the athlete approves at.
 *
 * Delegates to the library's client so the parameter set stays correct as
 * Garmin's spec moves, rather than being re-derived here.
 */
export function buildAuthorizeUrl(options: {
  authorizeEndpoint: string
  clientId: string
  redirectUri: string
  state: string
  challenge: string
  scope?: string
}): string {
  const client = createGarminClient({
    ...options,
    clientSecret: 'unused-for-url-building',
    endpoints: { authorize: options.authorizeEndpoint },
  })

  return client.buildAuthorizationUrl({ state: options.state, challenge: options.challenge })
}

/**
 * Is the integration usable?
 *
 * Checked before anything starts a flow, so an athlete gets "not available
 * yet" instead of a Garmin error page about an unknown client id.
 */
export function isConfigured(config: { clientId?: string, clientSecret?: string }): boolean {
  return Boolean(config?.clientId && config?.clientSecret)
}

/** Pull activity summaries out of a push payload. */
export function extractSummaries(body: unknown): GarminActivitySummary[] {
  return extractActivitySummaries(body)
}

/** Pull account-revocation notices out of a push payload. */
export function extractDisconnects(body: unknown): GarminDeregistration[] {
  return extractDeregistrations(body)
}

/**
 * Re-evaluate achievements for every athlete who gained an activity in a push.
 *
 * Imports write through `Activity.create`, not ActivityStoreAction, because
 * that action takes the actor from the session and a webhook has none. So the
 * unlock hook the recorder runs after every store has to run here too, or a
 * watch-only athlete's runs count toward nothing until they next do something
 * in the app.
 *
 * Once per athlete, not once per activity: a backfill replays history in one
 * push, and each evaluation re-reads all of that athlete's activities. Never
 * throws, because a non-2xx makes Garmin redeliver the whole batch. The
 * evaluator is passed in so this stays testable without a database.
 */
export async function evaluateImportedAthletes(
  userIds: Iterable<number>,
  evaluate: (userId: number) => Promise<unknown>,
): Promise<number> {
  let evaluated = 0
  for (const userId of new Set(userIds)) {
    try {
      await evaluate(userId)
      evaluated++
    }
    catch (error) {
      console.error('[garmin] could not evaluate achievements for user', userId, error)
    }
  }
  return evaluated
}

/** What has to survive the round trip to Garmin and back. */
export interface OAuthState {
  /** Which WildLoop account is connecting. */
  userId: number
  /** Echoed by Garmin, compared on return: the CSRF guard. */
  state: string
  /** Redeems the authorization code. Never leaves our side. */
  verifier: string
  /** Unix ms. A stale attempt is refused rather than resumed. */
  issuedAt: number
}

/** How long an in-flight connection attempt stays valid. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000

/**
 * Seal the in-flight OAuth state into a token safe to hand to a browser.
 *
 * This rides in an HttpOnly cookie because the callback is a top-level
 * redirect from Garmin, which carries no Authorization header - so the cookie
 * is the only thing that says who was connecting.
 *
 * It is signed, not merely hidden. Without the signature someone could edit
 * the `userId` in their own cookie and attach their watch to another person's
 * account, which is an account-takeover-shaped hole rather than a mix-up.
 */
export function sealOAuthState(state: OAuthState, secret: string): string {
  return signState(JSON.stringify(state), secret)
}

/**
 * Open a sealed state, or return null if it was tampered with, malformed, or
 * has expired. Null always means "start again", never "trust it anyway".
 */
export function openOAuthState(token: string | undefined, secret: string, now = Date.now()): OAuthState | null {
  if (!token || !secret)
    return null

  try {
    const verified = verifyState(token, secret)
    if (!verified)
      return null
    const parsed = JSON.parse(verified) as OAuthState
    if (typeof parsed?.userId !== 'number' || typeof parsed?.verifier !== 'string' || typeof parsed?.state !== 'string')
      return null
    if (!parsed.issuedAt || now - parsed.issuedAt > OAUTH_STATE_TTL_MS)
      return null
    return parsed
  }
  catch {
    return null
  }
}

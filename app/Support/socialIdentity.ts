/**
 * Signing in with Google (and, through the same `decideLink`, with Apple —
 * see appleSignIn.ts): the decisions, away from the network.
 *
 * Everything here is pure, so the parts that are easy to get quietly wrong —
 * which state is acceptable, whether an existing account may be linked, what
 * an account with no password of its own gets stored — are testable without a
 * provider, a browser, or a clock.
 *
 * The exchange itself lives in the callback action. This file never talks to
 * Google.
 */

/** How long a sign-in may sit half-finished before its state is refused. */
export const STATE_LIFETIME_MS = 10 * 60 * 1000

/**
 * Who a provider says somebody is. Google and Apple both reduce to this, which
 * is what lets one set of decisions serve both.
 */
export interface SocialProfile {
  /** The provider's own subject id. Stable for the account, unlike the address. */
  sub: string
  email: string
  emailVerified: boolean
  name?: string | null
  picture?: string | null
}

export type GoogleProfile = SocialProfile

export type LinkDecision =
  /** No account has this address: make one. */
  | { action: 'create', email: string, name: string }
  /** This Google account has signed in here before. */
  | { action: 'sign-in', userId: number }
  /** An account already has this address, and Google has proven it. */
  | { action: 'link', userId: number }
  /** Something is wrong enough that no account should be touched. */
  | { action: 'refuse', reason: 'unverified-email' | 'no-email' }

export interface ExistingUser {
  id: number
  email: string
}

/**
 * What to do with a profile Google (or Apple) has just vouched for.
 *
 * The order matters. A known identity signs in without consulting the address
 * at all, because the address is the one thing about a Google account that can
 * change; the subject id cannot.
 *
 * Linking by address is the step that deserves suspicion, because it hands
 * somebody an existing account on the strength of a claim. It is allowed only
 * when Google says it verified the address itself — an unverified address is a
 * string the person typed, and honouring it would let anyone who could type
 * somebody's email take their account. That is the whole of the security here,
 * so it is checked before anything else and refused rather than downgraded.
 */
export function decideLink(profile: SocialProfile, identityUserId: number | null, existing: ExistingUser | null): LinkDecision {
  if (identityUserId !== null)
    return { action: 'sign-in', userId: identityUserId }

  const email = profile.email?.trim().toLowerCase() ?? ''
  if (!email)
    return { action: 'refuse', reason: 'no-email' }
  if (!profile.emailVerified)
    return { action: 'refuse', reason: 'unverified-email' }

  if (existing)
    return { action: 'link', userId: existing.id }

  return { action: 'create', email, name: profile.name?.trim() || email.split('@')[0] }
}

/**
 * Whether a state value returned by Google is one we issued and still accept.
 *
 * Compared in full rather than by prefix, and bounded in time: a state is a
 * one-shot ticket, and an old one lying around in a browser's history should
 * not still open a session. `now` is a parameter so this can be tested at a
 * particular moment instead of near one.
 */
export function stateIsAcceptable(issued: { value: string, createdAt: number } | null, returned: string, now: number): boolean {
  if (!issued || !returned)
    return false
  if (issued.value.length < 16 || issued.value !== returned)
    return false
  const age = now - issued.createdAt
  return age >= 0 && age <= STATE_LIFETIME_MS
}

/**
 * The URL to send somebody to.
 *
 * `prompt=select_account` because the alternative is worse than it sounds: a
 * browser already signed into one Google account skips the chooser entirely,
 * so somebody trying to use their other account is silently signed in as the
 * wrong one with no way to tell.
 */
export function authorizeUrl(options: { clientId: string, redirectUri: string, state: string }): string {
  const query = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state: options.state,
    prompt: 'select_account',
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${query.toString()}`
}

/**
 * The claims we take from an id token, and nothing else.
 *
 * Google sends more than this. Reading only what is named here means a change
 * at their end adds a field we ignore rather than a shape we mis-handle, and
 * that nothing unexpected reaches a database column.
 */
export function profileFromClaims(claims: Record<string, unknown>): GoogleProfile | null {
  const sub = typeof claims.sub === 'string' ? claims.sub.trim() : ''
  if (!sub)
    return null
  return {
    sub,
    email: typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '',
    // Google sends this as a boolean, and has historically sent the string
    // "true" as well. Anything else is not a verification.
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: typeof claims.name === 'string' ? claims.name : null,
    picture: typeof claims.picture === 'string' ? claims.picture : null,
  }
}

/**
 * The rules behind API sessions, kept apart from the middleware so they can
 * be tested without a request or a database.
 *
 * A session is one opaque bearer token, sent as `Authorization: Bearer`. The
 * web app keeps it in localStorage and the iOS app in the Keychain; neither
 * ever sends it as a cookie.
 */

export const DAY_MS = 86_400_000

interface RequestLike {
  bearerToken?: () => string | null | undefined
  header?: (name: string) => string | null | undefined
  headers?: { get?: (name: string) => string | null }
}

/** The bearer token on a request, or null. Cookies are deliberately not read. */
export function bearerFrom(request: RequestLike): string | null {
  const direct = typeof request.bearerToken === 'function' ? request.bearerToken() : null
  if (direct)
    return direct

  const header = (typeof request.header === 'function' ? request.header('authorization') : null)
    ?? request.headers?.get?.('authorization')
    ?? null
  if (typeof header !== 'string' || !header.startsWith('Bearer '))
    return null

  const token = header.slice(7).trim()
  return token || null
}

/**
 * The new expiry for a token that was just used, or null to leave it alone.
 *
 * Expiry slides: someone who keeps using the app stays signed in, and a token
 * nobody has used for a whole lifetime expires. It moves at most once a day,
 * so an active session costs one extra write a day rather than one a request.
 */
export function slidExpiry(expiresAt: Date | null | undefined, now: number, lifetimeMs: number): Date | null {
  // A token issued without an expiry never lapses, so there is nothing to slide.
  if (!expiresAt || Number.isNaN(expiresAt.getTime()))
    return null
  if (expiresAt.getTime() - now > lifetimeMs - DAY_MS)
    return null
  return new Date(now + lifetimeMs)
}

/** The format the framework stores `oauth_access_tokens.expires_at` in: UTC, no zone suffix. */
export function tokenTimestamp(date: Date): string {
  return date.toISOString().slice(0, 23)
}

/**
 * Apple's refresh token: kept from sign-in for one purpose, revoking it when
 * the account is deleted.
 *
 * Apple requires an app offering Sign in with Apple to revoke the user tokens
 * when somebody deletes their account, through `POST /auth/revoke`. Doing it
 * ends Wildloop's authorization in the person's Apple ID settings, so a later
 * sign-in starts fresh, asks for a name again, and makes a new account rather
 * than finding an Apple link to one that is gone.
 *
 * The token is sealed with APP_KEY before it is stored, and is never logged or
 * sent anywhere but Apple. Revoking is best effort: an Apple that cannot be
 * reached is logged, and never keeps an account from being deleted.
 *
 * The network half takes its `fetch` as an argument, so the request it makes
 * can be checked without Apple.
 */

import type { AppleCredentials } from './appleSignIn'
import { config } from '@stacksjs/config'
import { db } from '@stacksjs/orm'
import { decrypt, encrypt } from '@stacksjs/security'
import { APPLE_ISSUER, appleClientSecret } from './appleSignIn'

export const APPLE_REVOKE_URL = `${APPLE_ISSUER}/auth/revoke`

/** Long enough for Apple on a bad day, short enough not to hold a deletion up. */
const REVOKE_TIMEOUT_MS = 10_000

type Fetch = (input: string, init: RequestInit) => Promise<Response>

/** The request Apple's revoke endpoint wants for a refresh token, field for field. */
export function appleRevokeRequest(clientId: string, clientSecret: string, refreshToken: string): { url: string, init: RequestInit } {
  return {
    url: APPLE_REVOKE_URL,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        token: refreshToken,
        token_type_hint: 'refresh_token',
      }),
    },
  }
}

export type RevokeOutcome = { ok: true, reason?: undefined } | { ok: false, reason: string }

/**
 * Ask Apple to revoke one refresh token. Never throws: the answer says whether
 * it worked, and why not, in words safe to log. Apple answers a failure with a
 * short code such as `invalid_client`, and the token is never part of it.
 */
export async function revokeAppleToken(
  refreshToken: string,
  credentials: AppleCredentials,
  options: { fetch?: Fetch, now?: number, timeoutMs?: number } = {},
): Promise<RevokeOutcome> {
  try {
    const clientSecret = await appleClientSecret(credentials, options.now)
    const { url, init } = appleRevokeRequest(credentials.clientId, clientSecret, refreshToken)
    const send: Fetch = options.fetch ?? ((input, request) => fetch(input, request))
    const response = await send(url, { ...init, signal: AbortSignal.timeout(options.timeoutMs ?? REVOKE_TIMEOUT_MS) })
    if (response.ok)
      return { ok: true }
    const detail = (await response.text().catch(() => '')).slice(0, 200)
    return { ok: false, reason: `Apple answered ${response.status}${detail ? ` ${detail}` : ''}` }
  }
  catch (error) {
    return { ok: false, reason: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error' }
  }
}

/** Seal a token for the database. `key` is for tests; the app uses APP_KEY. */
export async function sealToken(token: string, key?: string): Promise<string> {
  return await encrypt(token, key)
}

export async function openToken(sealed: string, key?: string): Promise<string> {
  return await decrypt(sealed, key)
}

/**
 * Keep the refresh token from an Apple sign-in, replacing the one before.
 * Each sign-in issues a new one, and any of them revokes the authorization.
 */
export async function rememberAppleRefreshToken(userId: number, sub: string, refreshToken: string): Promise<void> {
  const sealed = await sealToken(refreshToken)
  await db.sql`
    UPDATE user_identities SET refresh_token = ${sealed}, updated_at = ${new Date().toISOString()}
    WHERE provider = 'apple' AND provider_user_id = ${sub} AND user_id = ${userId}
  `.execute()
}

/** The sealed Apple refresh tokens an account holds, read before its rows go. */
export async function sealedAppleTokensFor(userId: number): Promise<string[]> {
  const rows = await db.sql`
    SELECT refresh_token FROM user_identities
    WHERE user_id = ${userId} AND provider = 'apple' AND refresh_token IS NOT NULL
  `.execute() as any[]
  return rows.map(row => String(row.refresh_token ?? '')).filter(Boolean)
}

/** Apple's credentials as configured, or null when Sign in with Apple is off. */
function configuredApple(): AppleCredentials | null {
  const apple = (config as any).auth?.social?.apple
  if (!apple?.configured)
    return null
  return { clientId: apple.clientId, teamId: apple.teamId, keyId: apple.keyId, privateKey: apple.privateKey }
}

/**
 * Revoke every sealed token given, best effort. Each failure is logged, with
 * the reason and never the token, and counted. Nothing here throws.
 */
export async function revokeAppleTokens(
  sealed: readonly string[],
  options: { credentials?: AppleCredentials | null, fetch?: Fetch, key?: string, now?: number } = {},
): Promise<{ revoked: number, failed: number }> {
  if (!sealed.length)
    return { revoked: 0, failed: 0 }

  const credentials = options.credentials === undefined ? configuredApple() : options.credentials
  if (!credentials) {
    console.error(`[account] Sign in with Apple is not configured, so ${sealed.length} Apple token(s) could not be revoked`)
    return { revoked: 0, failed: sealed.length }
  }

  let revoked = 0
  let failed = 0
  for (const value of sealed) {
    const token = await openToken(value, options.key).catch(() => null)
    if (!token) {
      console.error('[account] could not unseal a stored Apple token, so it was not revoked')
      failed++
      continue
    }
    const outcome = await revokeAppleToken(token, credentials, { fetch: options.fetch, now: options.now })
    if (outcome.ok) {
      revoked++
    }
    else {
      console.error('[account] could not revoke an Apple token:', outcome.reason)
      failed++
    }
  }
  return { revoked, failed }
}

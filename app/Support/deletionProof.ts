/**
 * What a request to delete an account has to carry, kept apart from the
 * action so the rules can be tested without a server.
 *
 * A bearer token alone proves a device, not a person, and deletion cannot be
 * undone, so something more is asked for:
 *
 *   - An account with a password of its own types it again, exactly as before.
 *   - An account with no password (Google or Apple made it, see
 *     accountPassword.ts) types DELETE instead, and only from a session opened
 *     in the last 15 minutes. Signing in again with the provider is the
 *     re-authentication a password would have been: a phone left unlocked
 *     for an hour, or a token lifted from a backup, is not enough.
 */

import type { SocialProvider } from './socialAccount'

/** What an account without a password types to confirm. */
export const DELETE_CONFIRMATION = 'DELETE'

/** How recent a sign-in has to be for an account without a password. */
export const RECENT_SIGN_IN_MS = 15 * 60_000

/** Allowance for a server clock a little behind the one that stamped the token. */
const CLOCK_SKEW_MS = 60_000

export interface DeletionRequest {
  hasPassword: boolean
  providers: readonly SocialProvider[]
  password: string
  confirmation: string
  /** When the session making the request was issued, or null if unknown. */
  sessionIssuedAt: Date | null
  now: number
}

export type DeletionProof =
  /** Check this password, as for any password account. */
  | { kind: 'password', password: string }
  /** No password to check, and the confirmation and session both hold. */
  | { kind: 'confirmed' }
  | { kind: 'refused', status: 403 | 422, body: Record<string, unknown> }

/** "Google", "Apple", or "Google or Apple": how this person signs in. */
export function providerNames(providers: readonly SocialProvider[]): string {
  const names = [...new Set(providers)].sort().map(provider => (provider === 'google' ? 'Google' : 'Apple'))
  return names.length ? names.join(' or ') : 'Google or Apple'
}

/** A session issued within the window, allowing for a little clock skew. */
export function sessionIsRecent(issuedAt: Date | null, now: number, windowMs = RECENT_SIGN_IN_MS): boolean {
  if (!issuedAt || Number.isNaN(issuedAt.getTime()))
    return false
  const age = now - issuedAt.getTime()
  return age >= -CLOCK_SKEW_MS && age <= windowMs
}

export function deletionProof(request: DeletionRequest): DeletionProof {
  if (request.hasPassword) {
    if (!request.password)
      return { kind: 'refused', status: 422, body: { success: false, error: 'Enter your password to delete your account.', fields: { password: 'Enter your password.' } } }
    return { kind: 'password', password: request.password }
  }

  if (request.confirmation.trim().toUpperCase() !== DELETE_CONFIRMATION) {
    const error = `Type ${DELETE_CONFIRMATION} to confirm.`
    return { kind: 'refused', status: 422, body: { success: false, error, fields: { confirmation: error }, confirm: DELETE_CONFIRMATION } }
  }

  if (!sessionIsRecent(request.sessionIssuedAt, request.now)) {
    const provider = providerNames(request.providers)
    return {
      kind: 'refused',
      status: 403,
      body: {
        success: false,
        error: `For your security, sign out, sign in again with ${provider}, and then delete your account within ${RECENT_SIGN_IN_MS / 60_000} minutes.`,
        reason: 'reauthenticate',
      },
    }
  }

  return { kind: 'confirmed' }
}

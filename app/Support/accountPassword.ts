/**
 * Whether an account has a password its owner knows.
 *
 * Most do: they registered with one. An account that signing in with Google
 * or Apple created does not. `users.password` is NOT NULL, so it holds the
 * hash of 32 random bytes nobody ever saw (see socialAccount.ts), and asking
 * for "your password" there asks for something that does not exist.
 *
 * Two facts decide it, both already recorded:
 *   - `user_identities.created_account`: the provider sign-in made the account
 *     rather than being linked to one somebody had registered.
 *   - `users.password_changed_at`: stamped whenever a password is set, by the
 *     reset flow or a change. An account that was made by Google and later
 *     given a password through "forgot password" has one from then on.
 */

import type { SocialProvider } from './socialAccount'
import { db } from '@stacksjs/orm'

export interface PasswordEvidence {
  /** Some provider sign-in created this account. */
  createdByProvider: boolean
  /** When a password was last set by its owner, or null if never. */
  passwordChangedAt: string | null
}

export function hasOwnPassword(evidence: PasswordEvidence): boolean {
  return !evidence.createdByProvider || Boolean(evidence.passwordChangedAt)
}

export interface AccountPassword {
  hasPassword: boolean
  /** Every provider the account signs in with, for telling its owner which to use. */
  providers: SocialProvider[]
}

/**
 * Whether `userId` has a password of its own, read from the database.
 *
 * Any failure answers "it has one": that is the behaviour every account had
 * before this existed, and it never lets anybody past the password check on
 * an account that has a password.
 */
export async function accountPassword(userId: number): Promise<AccountPassword> {
  try {
    const user = (await db.sql`SELECT password_changed_at FROM users WHERE id = ${userId}`.execute() as any[])[0]
    const identities = await db.sql`
      SELECT provider, created_account FROM user_identities WHERE user_id = ${userId}
    `.execute() as any[]
    const providers = [...new Set(identities.map(row => String(row.provider)))]
      .filter((provider): provider is SocialProvider => provider === 'google' || provider === 'apple')
    return {
      hasPassword: hasOwnPassword({
        createdByProvider: identities.some(row => Number(row.created_account) === 1),
        passwordChangedAt: user?.password_changed_at ? String(user.password_changed_at) : null,
      }),
      providers,
    }
  }
  catch (error) {
    console.error('[account] could not tell whether the account has a password', error)
    return { hasPassword: true, providers: [] }
  }
}

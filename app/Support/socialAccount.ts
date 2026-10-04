/**
 * Turning a profile a provider has vouched for into a Wildloop session.
 *
 * Shared by Google and Apple: once the provider's token has been exchanged
 * and read, deciding who somebody is, creating or linking their account,
 * opening the session and recording the identity are the same steps for
 * both, and they are the steps where a mistake costs somebody their account.
 * One copy of them is one copy to get right.
 *
 * The provider-specific halves — the state, the exchange, the claims — stay
 * in each callback action. Nothing here talks to a provider.
 */

import type { SocialProfile } from './socialIdentity'
import { Auth, resolveBrowserSessionPolicy } from '@stacksjs/auth'
import { log } from '@stacksjs/logging'
import { db } from '@stacksjs/orm'
import { decideLink } from './socialIdentity'

export type SocialProvider = 'google' | 'apple'

export type SocialSignInOutcome =
  | { ok: true, token: string, userId: number }
  /**
   * `unverified`: the provider has not verified the address, so it may not
   * open or create an account. `failed`: anything else, none of it the
   * visitor's to fix.
   */
  | { ok: false, reason: 'unverified' | 'failed' }

/**
 * Record the identity, and answer whether it is on record afterwards.
 *
 * A unique-index clash is the one failure that is not one: the row is already
 * there, from a retry or from two tabs racing. Re-reading tells that apart from
 * a real failure without depending on a particular driver's spelling of
 * "insert or ignore", or on matching its error codes — this app runs on SQLite
 * in production and is configured for MySQL and Postgres as well.
 *
 * A row claiming this provider account for somebody else is not a clash to
 * forgive. It should be impossible, since the lookup found nothing, but if it
 * ever happens the honest answer is to refuse rather than hand over a session
 * tied to an identity that belongs to another account.
 */
async function identityIsOnRecord(
  provider: SocialProvider,
  userId: number,
  profile: { sub: string, email: string },
  now: string,
  createdAccount: boolean,
): Promise<boolean> {
  try {
    // `created_account` marks the account as one nobody holds a password for,
    // which is what lets its owner delete it without one (see
    // app/Support/accountPassword.ts).
    await db.sql`
      INSERT INTO user_identities (user_id, provider, provider_user_id, email, created_account, created_at, updated_at)
      VALUES (${userId}, ${provider}, ${profile.sub}, ${profile.email || null}, ${createdAccount ? 1 : 0}, ${now}, ${now})
    `.execute()
    return true
  }
  catch (error) {
    const existing = (await db.sql`
      SELECT user_id FROM user_identities WHERE provider = ${provider} AND provider_user_id = ${profile.sub}
    `.execute().catch(() => []) as any[])[0]

    if (existing && Number(existing.user_id) === userId)
      return true

    log.error(`[auth] could not record a ${provider} identity`, error)
    return false
  }
}

/**
 * Sign somebody in from a profile the provider has vouched for: find their
 * account, link one, or create one, and open a session for it.
 *
 * The account is created only here, after the provider's token exchange has
 * succeeded — never before — so a flow abandoned anywhere earlier leaves no
 * half-created user behind.
 */
export async function finishSocialSignIn(provider: SocialProvider, profile: SocialProfile): Promise<SocialSignInOutcome> {
  const identity = (await db.sql`
    SELECT user_id FROM user_identities WHERE provider = ${provider} AND provider_user_id = ${profile.sub}
  `.execute() as any[])[0]
  const existing = profile.email
    ? (await db.sql`SELECT id, email FROM users WHERE lower(email) = ${profile.email}`.execute() as any[])[0]
    : null

  const decision = decideLink(
    profile,
    identity ? Number(identity.user_id) : null,
    existing ? { id: Number(existing.id), email: String(existing.email) } : null,
  )
  if (decision.action === 'refuse')
    return { ok: false, reason: decision.reason === 'unverified-email' ? 'unverified' : 'failed' }

  let userId = 0
  const now = new Date().toISOString()
  if (decision.action === 'create') {
    /*
     * An account nobody has a password for.
     *
     * `users.password` is NOT NULL in every database, generated from the
     * model's own validation rule, and SQLite cannot relax a column without
     * rebuilding the table — which is not a thing to do to a live users
     * table for tidiness. So the column gets 32 random bytes, hashed, with
     * the plaintext discarded unread. Nobody can sign in with a password
     * because there is no password to type, and "forgot password" still
     * works if this person later wants one.
     */
    const { makeHash } = await import('@stacksjs/security')
    const unguessable = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('')
    const created = (await db.sql`
      INSERT INTO users (name, email, password, created_at, updated_at)
      VALUES (${decision.name}, ${decision.email}, ${await makeHash(unguessable, { algorithm: 'bcrypt' })}, ${now}, ${now})
      RETURNING id
    `.execute() as any[])[0]
    userId = Number(created?.id ?? 0)
  }
  else {
    userId = decision.userId
  }

  if (!userId)
    return { ok: false, reason: 'failed' }

  // Remembered on purpose: somebody who signs in with a provider did not
  // choose a session length, and the provider is the thing they will use
  // again. This matches the "remember me" branch rather than the 12-hour one.
  const policy = resolveBrowserSessionPolicy(true)
  const session = await Auth.loginUsingId(userId, {
    expiresInMinutes: policy.expiresInMinutes,
    withRefreshToken: policy.withRefreshToken,
  }).catch((error: unknown) => {
    console.error(`[auth] could not open a session for a ${provider} sign-in`, error)
    return null
  })
  if (!session?.token)
    return { ok: false, reason: 'failed' }

  // Written after the session, so a failure above leaves no identity row
  // claiming a provider account that never signed in.
  //
  // A sign-in whose identity was not recorded looks exactly like one that
  // worked, and goes wrong later: without the row, every future sign-in
  // falls back to matching on the address, so the day somebody's Wildloop
  // address differs from their provider's they quietly get a second, empty
  // account instead of their own. That is worth refusing over — anyone who
  // reached here through an existing account still has their password, and
  // anyone new can try again.
  if (decision.action !== 'sign-in' && !(await identityIsOnRecord(provider, userId, profile, now, decision.action === 'create'))) {
    log.error(`[auth] refused a ${provider} sign-in whose identity could not be recorded`, { userId, provider })
    return { ok: false, reason: 'failed' }
  }

  return { ok: true, token: session.token, userId }
}

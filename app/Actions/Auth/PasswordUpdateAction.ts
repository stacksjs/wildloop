// `Auth` is imported explicitly: it is not in the API server bundle's
// auto-imports, so `Auth.user()` throws at runtime while type-checking clean.
import { Auth } from '@stacksjs/auth'
import { db } from '@stacksjs/database'
import { makeHash } from '@stacksjs/security'

import { passwordChangeError, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../../../resources/functions/password-change'

/**
 * Change the signed-in user's password.
 *
 * Distinct from the reset flow: that one proves identity with a token mailed
 * to the address, this one proves it with the password already held. Both end
 * at the same place — a bcrypt hash in `users.password` and a fresh
 * `password_changed_at` stamp.
 *
 * The current password is checked through `Auth.validate`, which verifies
 * credentials without issuing a token or touching the session, so a wrong
 * guess here cannot hand anybody a new one.
 */
export default new Action({
  name: 'Password Update',
  description: "Change the signed-in user's password",
  method: 'POST',

  validations: {
    current_password: {
      rule: schema.string().required().min(1).max(PASSWORD_MAX_LENGTH),
      message: 'Enter your current password.',
    },
    password: {
      rule: schema.string().required().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
      message: `Your new password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    },
  },

  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const currentPassword = String(request.get('current_password') ?? '')
    const newPassword = String(request.get('password') ?? '')
    const confirmation = String(request.get('password_confirmation') ?? '')

    // Re-checked here rather than trusted from the form: `validations:` only
    // runs through the router, and the cross-field rules (confirmation, and
    // "not the one you already have") cannot be expressed there at all.
    const invalid = passwordChangeError(currentPassword, newPassword, confirmation)
    if (invalid)
      return response.json({ success: false, error: invalid }, 422)

    const email = String(user.email ?? '')
    const correct = await Auth.validate({ email, password: currentPassword }).catch(() => false)
    if (!correct)
      return response.json({ success: false, error: 'That is not your current password.' }, 403)

    const hashed = await makeHash(newPassword, { algorithm: 'bcrypt' })

    try {
      await db.updateTable('users')
        .set({ password: hashed, password_changed_at: new Date().toISOString() })
        .where('id', '=', user.id)
        .executeTakeFirst()
    }
    catch (error) {
      // The stamp is a newer column than the password itself. An app that has
      // not migrated should still be able to change a password, so only the
      // stamp is dropped — never the change the user asked for.
      const message = error instanceof Error ? error.message : String(error)
      if (!/password_changed_at|no such column|unknown column/i.test(message)) {
        console.error('[password] update failed', message)
        return response.json({ success: false, error: 'Could not change your password' }, 500)
      }

      await db.updateTable('users')
        .set({ password: hashed })
        .where('id', '=', user.id)
        .executeTakeFirst()
    }

    // Every other session was opened with the old password. Someone changing
    // it because they think it is known is doing exactly this to end those,
    // and the token on this request stays valid so they are not signed out of
    // the page they are standing on.
    await Auth.revokeOtherTokens(user.id).catch((error: unknown) => {
      console.error('[password] could not revoke other sessions', error)
    })

    // Signed out, those devices must stop receiving this athlete's
    // notifications too. Push registrations belong to a device, not a session,
    // so revoking the sessions left them behind, and a phone that had lost its
    // session still lit up with someone else's kudos. The device making the
    // change keeps its own: it names itself with the `device_id` it
    // registered push with.
    const keepDevice = String(request.get('device_id') ?? '').trim().slice(0, 255)
    await (keepDevice
      ? db.sql`DELETE FROM device_push_tokens WHERE user_id = ${user.id} AND (device_id IS NULL OR device_id != ${keepDevice})`
      : db.sql`DELETE FROM device_push_tokens WHERE user_id = ${user.id}`
    ).execute().catch((error: unknown) => {
      console.error('[password] could not remove other devices from push', error)
    })

    // The stamp above ends every session opened before this moment, this one
    // included: the framework refuses a token issued before the password
    // changed. So the page that promised to keep you signed in here signed you
    // out on its next request. Hand this device a new session instead, and
    // retire the old one.
    const fresh = await Auth.createTokenForUser(user, { name: 'user-auth-token' })
    await Auth.logout().catch(() => undefined)

    return response.json({
      success: true,
      message: 'Password changed. Other devices have been signed out.',
      token: fresh.plainTextToken,
    })
  },
})

// `Auth` is imported explicitly: it is not in the API server bundle's
// auto-imports, so `Auth.user()` throws at runtime while type-checking clean.
import { Auth } from '@stacksjs/auth'
import { deleteAccount } from '../../Support/accountDeletion'

/**
 * DELETE /api/me - delete the signed-in account and everything it made
 * (see app/Support/accountDeletion.ts for what goes and what stays).
 *
 * The password is asked for again. A bearer token alone proves a device, not
 * a person, and this cannot be undone: a phone left unlocked, or a token
 * lifted from a backup, must not be enough to erase someone's history.
 */
export default new Action({
  name: 'AccountDestroyAction',
  description: 'Delete the signed-in account and everything it made',
  method: 'DELETE',

  async handle(request) {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const password = String(request.get('password') ?? '')
    if (!password)
      return response.json({ success: false, error: 'Enter your password to delete your account.', fields: { password: 'Enter your password.' } }, 422)

    const correct = await Auth.validate({ email: String(user.email ?? ''), password }).catch(() => false)
    if (!correct)
      return response.json({ success: false, error: 'That is not your password.' }, 403)

    const report = await deleteAccount(Number(user.id))
    console.info('[account] deleted user', user.id, report)
    return new Response(null, { status: 204 })
  },
})

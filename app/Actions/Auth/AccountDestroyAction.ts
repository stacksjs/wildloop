// `Auth` is imported explicitly: it is not in the API server bundle's
// auto-imports, so `Auth.user()` throws at runtime while type-checking clean.
import { Auth } from '@stacksjs/auth'
import { deleteAccount } from '../../Support/accountDeletion'
import { accountPassword } from '../../Support/accountPassword'
import { deletionProof } from '../../Support/deletionProof'

/**
 * DELETE /api/me - delete the signed-in account and everything it made
 * (see app/Support/accountDeletion.ts for what goes and what stays).
 *
 * The password is asked for again. A bearer token alone proves a device, not
 * a person, and this cannot be undone: a phone left unlocked, or a token
 * lifted from a backup, must not be enough to erase someone's history.
 *
 * An account Google or Apple created has no password to ask for, so it types
 * DELETE instead, from a session opened in the last 15 minutes: signing in
 * again with the provider stands in for the password (see deletionProof.ts).
 */
export default new Action({
  name: 'AccountDestroyAction',
  description: 'Delete the signed-in account and everything it made',
  method: 'DELETE',

  async handle(request: any) {
    const user = await Auth.user().catch(() => null)
    if (!user)
      return response.json({ success: false, error: 'Authentication required' }, 401)

    const { hasPassword, providers } = await accountPassword(Number(user.id))
    // The auth middleware has already looked the token up. Asking again is
    // for a request that reached here some other way.
    const session = request?._currentAccessToken ?? await Auth.currentAccessToken().catch(() => null)
    const proof = deletionProof({
      hasPassword,
      providers,
      password: String(request.get('password') ?? ''),
      confirmation: String(request.get('confirmation') ?? ''),
      sessionIssuedAt: session?.createdAt ? new Date(session.createdAt) : null,
      now: Date.now(),
    })
    if (proof.kind === 'refused')
      return response.json(proof.body, proof.status)

    if (proof.kind === 'password') {
      const correct = await Auth.validate({ email: String(user.email ?? ''), password: proof.password }).catch(() => false)
      if (!correct)
        return response.json({ success: false, error: 'That is not your password.' }, 403)
    }

    const report = await deleteAccount(Number(user.id))
    console.info('[account] deleted user', user.id, report)
    return new Response(null, { status: 204 })
  },
})

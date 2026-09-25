// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.

/**
 * The signed-in user's role names, for the UI to decide what to offer.
 *
 * Never load-bearing: every admin endpoint re-checks the role itself, because
 * anything handed to the client is something the client can edit. A failure
 * here degrades to "no roles", which shows a plain account rather than
 * blocking sign-in over a dashboard affordance.
 */
import { Auth, resolveBrowserSessionPolicy } from '@stacksjs/auth'
import { profileFields } from '../../Support/avatars'

async function roleNamesFor(userId?: number): Promise<string[]> {
  if (!userId)
    return []

  try {
    const { createBqbRbacStore, Rbac } = await import('@stacksjs/auth')
    Rbac.setStore(createBqbRbacStore())
    const roles = await Rbac.getUserRoles(userId)
    return (roles ?? []).map((role: any) => String(role?.name ?? '')).filter(Boolean)
  }
  catch {
    return []
  }
}

export default new Action({
  name: 'LoginAction',
  description: 'Login to the application',
  method: 'POST',

  validations: {
    email: {
      rule: schema.string().email(),
      message: 'Email must be a valid email address.',
    },
    password: {
      rule: schema.string().min(6).max(255),
      message: 'Password must be between 6 and 255 characters.',
    },
  },

  async handle(request: RequestInstance) {
    const email = request.get('email')
    const password = request.get('password')

    // "Remember me" on the sign-in form. The page used to show the box and
    // send nothing, so every session lasted thirty days whether the person
    // asked for that or not — on a borrowed laptop as much as their own.
    // config/auth.ts holds both lifetimes; the browser matches this by
    // keeping an ordinary session in session storage (assets/scripts/auth.ts).
    const policy = resolveBrowserSessionPolicy(request.get('remember'))

    const result = await Auth.login({ email, password }, {
      expiresInMinutes: policy.expiresInMinutes,
      withRefreshToken: policy.withRefreshToken,
    })

    if (result) {
      const user = result.user

      return response.json({
        success: true,
        token: result.token,
        // Seconds, as the token was actually issued. The client does not
        // renew, so this is how long this sign-in lasts.
        expires_in: result.expiresIn,
        remembered: policy.remembered,
        user: {
          id: user?.id,
          email: user?.email,
          name: user?.name,
          // Avatar, bio, location and join date, as /api/me answers them, so
          // the header shows a face straight after signing in.
          ...profileFields(user),
          // Roles ride along so the UI can decide what to offer (an Admin link
          // for an admin, nothing for everyone else) without a second request
          // on every page load. This is a HINT, never the gate: every admin
          // endpoint re-checks the role server-side, because anything the
          // client holds is something the client can edit.
          roles: await roleNamesFor(user?.id),
        },
      })
    }

    return response.json({ success: false, error: 'Incorrect email or password' }, 401)
  },
})

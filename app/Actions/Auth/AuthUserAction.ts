// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.
//
// GET /me - returns the authenticated user. Registered behind the `auth`
// middleware in routes/api.ts, so reaching handle() implies a valid token; we
// still guard defensively. The frontend calls this on mount (auth.user()).

import { Auth } from '@stacksjs/auth'

export default new Action({
  name: 'Auth User',
  description: 'Return the currently authenticated user',
  method: 'GET',

  async handle() {
    const user = await Auth.user()
    if (!user)
      return response.json({ success: false, error: 'Unauthenticated' }, 401)

    let roles: string[] = []
    try {
      const { createBqbRbacStore, Rbac } = await import('@stacksjs/auth')
      Rbac.setStore(createBqbRbacStore())
      roles = ((await Rbac.getUserRoles(user.id)) ?? [])
        .map((role: any) => String(role?.name ?? ''))
        .filter(Boolean)
    }
    catch {
      roles = []
    }

    return response.json({
      success: true,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles,
      },
    })
  },
})

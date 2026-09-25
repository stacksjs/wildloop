// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports,
// so `Auth.user()` threw "Auth.user is not a function" at runtime in production
// while type-checking clean against the declarations. Everything else here is
// auto-imported as usual.

import { Auth } from '@stacksjs/auth'
import { log } from '@stacksjs/logging'
import { profileFields } from '../../Support/avatars'

export default new Action({
  name: 'RegisterAction',
  description: 'Register a new user',
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
    name: {
      rule: schema.string().min(2).max(255),
      message: 'Name must be between 2 and 255 characters.',
    },
  },

  async handle(request: RequestInstance) {
    const email = request.get('email')
    const password = request.get('password')
    const name = request.get('name')

    let result: Awaited<ReturnType<typeof register>> | undefined
    try {
      result = await register({ email, password, name })
    }
    catch (error) {
      // A refusal the person can act on (a taken email, a short password) is
      // a 4xx with its own message and not an incident. Anything else goes to
      // bughq before it becomes a 500: the app only says "Something went
      // wrong on our end", so this is where the cause is kept.
      const status = (error as { status?: unknown } | null)?.status
      if (status === 409) {
        const message = 'An account with this email already exists. Log in or reset your password.'
        return response.json({ success: false, error: message, errors: { email: [message] } }, 409)
      }
      if (typeof status !== 'number' || status >= 500)
        void log.error(error instanceof Error ? error : new Error(`Registration failed: ${String(error)}`))
      throw error
    }

    if (result) {
      const user = await Auth.getUserFromToken(result.token)

      return response.json({
        success: true,
        token: result.token,
        user: {
          id: user?.id,
          email: user?.email,
          name: user?.name,
          // A new account has no photo yet, but the shape matches /api/me.
          ...profileFields(user),
        },
      })
    }

    void log.error(new Error('Registration failed: register() returned no token'))
    return response.json({ success: false, error: 'Registration failed' }, 500)
  },
})

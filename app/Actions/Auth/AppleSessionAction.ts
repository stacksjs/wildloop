// POST /api/auth/apple/session — trade the hand-off cookie for the session.
//
// Google's hand-off with Apple's cookie; the work is in socialSession.ts.

import { APPLE_HANDOFF_COOKIE } from '../../Support/socialRequest'
import { spendHandoff } from '../../Support/socialSession'

export default new Action({
  name: 'Apple Session',
  description: 'Exchange a completed Apple sign-in for its session',
  method: 'POST',

  async handle(request: any) {
    return await spendHandoff(request, APPLE_HANDOFF_COOKIE)
  },
})

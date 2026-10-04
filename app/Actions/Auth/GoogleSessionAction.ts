// POST /api/auth/google/session — trade the hand-off cookie for the session.
//
// The callback could not put a bearer token into browser storage, and would
// not put one in a URL, so it left the token in a one-minute httpOnly cookie
// and sent the browser to a page. That page calls this once. The cookie is
// cleared on the way out, so it works exactly once whatever happens next.
// The work is in socialSession.ts, which Apple's hand-off shares.

import { HANDOFF_COOKIE } from '../../Support/socialRequest'
import { spendHandoff } from '../../Support/socialSession'

export default new Action({
  name: 'Google Session',
  description: 'Exchange a completed Google sign-in for its session',
  method: 'POST',

  async handle(request: any) {
    return await spendHandoff(request, HANDOFF_COOKIE)
  },
})

// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports.
//
// POST /api/auth/google/session — trade the hand-off cookie for the session.
//
// The callback could not put a bearer token into browser storage, and would
// not put one in a URL, so it left the token in a one-minute httpOnly cookie
// and sent the browser to a page. That page calls this once. The cookie is
// cleared on the way out, so it works exactly once whatever happens next.

import { Auth } from '@stacksjs/auth'
import { profileFields } from '../../Support/avatars'
import { clearCookieHeader, cookieValue, HANDOFF_COOKIE } from '../../Support/socialRequest'

export default new Action({
  name: 'Google Session',
  description: 'Exchange a completed Google sign-in for its session',
  method: 'POST',

  async handle(request: any) {
    const cookieHeader = request.headers?.get?.('cookie') ?? request.header?.('cookie') ?? null
    const token = cookieValue(cookieHeader, HANDOFF_COOKIE)
    const spent = clearCookieHeader(HANDOFF_COOKIE)

    if (!token) {
      return new Response(JSON.stringify({ success: false, error: 'That sign-in has expired. Please try again.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': spent, 'Cache-Control': 'no-store' },
      })
    }

    // The token is only worth handing over if it still opens a session — a
    // cookie from a sign-in that has since been revoked should answer the same
    // as no cookie at all.
    const user = await Auth.getUserFromToken(token).catch(() => null)
    if (!user?.id) {
      return new Response(JSON.stringify({ success: false, error: 'That sign-in has expired. Please try again.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': spent, 'Cache-Control': 'no-store' },
      })
    }

    return new Response(JSON.stringify({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        ...profileFields(user),
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': spent, 'Cache-Control': 'no-store' },
    })
  },
})

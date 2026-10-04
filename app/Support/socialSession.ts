/**
 * The last step of a provider sign-in: the page trades the hand-off cookie
 * for the session the callback opened.
 *
 * The callback could not put a bearer token into browser storage, and would
 * not put one in a URL, so it left the token in a one-minute httpOnly cookie
 * and sent the browser to a page. That page asks for it once. The cookie is
 * cleared on the way out, so it works exactly once whatever happens next.
 *
 * Shared by Google and Apple, which differ only in the cookie's name.
 */

// Auth is imported explicitly: it is NOT in the API server bundle's auto-imports.
import { Auth } from '@stacksjs/auth'
import { profileFields } from './avatars'
import { clearCookieHeader, cookieValue } from './socialRequest'

function expired(spent: string): Response {
  return new Response(JSON.stringify({ success: false, error: 'That sign-in has expired. Please try again.' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': spent, 'Cache-Control': 'no-store' },
  })
}

export async function spendHandoff(request: any, cookieName: string): Promise<Response> {
  const cookieHeader = request.headers?.get?.('cookie') ?? request.header?.('cookie') ?? null
  const token = cookieValue(cookieHeader, cookieName)
  const spent = clearCookieHeader(cookieName)

  if (!token)
    return expired(spent)

  // The token is only worth handing over if it still opens a session — a
  // cookie from a sign-in that has since been revoked should answer the same
  // as no cookie at all.
  const user = await Auth.getUserFromToken(token).catch(() => null)
  if (!user?.id)
    return expired(spent)

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
}

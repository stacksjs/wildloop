/**
 * The request-shaped parts of a social sign-in: where Google sends the browser
 * back to, and how the one-shot state travels.
 *
 * Separate from `socialIdentity.ts`, which is the decisions. This file knows
 * about cookies and hosts; that one knows about nothing.
 */

/** Where the state lives between the redirect and the callback. */
export const STATE_COOKIE = 'wl_google_state'

/**
 * Where the new session waits between the callback and the page that claims it.
 *
 * A redirect cannot put a bearer token into browser storage, and returning one
 * in the URL writes a live credential into history. This cookie carries it
 * instead: httpOnly so no script can read it, and short enough that an
 * interrupted hand-off expires rather than waits.
 */
export const HANDOFF_COOKIE = 'wl_google_handoff'

/** Matches `STATE_LIFETIME_MS` in socialIdentity, in the unit Set-Cookie wants. */
const STATE_COOKIE_SECONDS = 10 * 60

/**
 * The redirect URI, which must match a URI registered in the Google console
 * character for character or Google refuses the whole flow.
 *
 * Derived from the request rather than from config, because the same build
 * serves wildloop.org, a local dev server and the QA harness on three
 * different origins, and each is registered separately. Taken from the app's
 * own URL when there is one, since a forwarded Host header is attacker-supplied
 * and this value decides where an authorization code is delivered.
 */
export function googleRedirectUri(request: { get?: (key: string) => unknown, url?: string }, env: Record<string, string | undefined> = process.env): string {
  const configured = (env.APP_URL ?? '').trim()
  if (configured)
    return `${withScheme(configured).replace(/\/+$/, '')}/api/auth/google/callback`

  // No APP_URL: fall back to the origin this request arrived on. Only used in
  // development, where APP_URL is set anyway; it exists so a misconfigured box
  // fails at Google's redirect-URI check rather than by building a broken URL.
  const url = typeof request?.url === 'string' ? request.url : ''
  const origin = url ? new URL(url).origin : 'http://localhost:3000'
  return `${origin}/api/auth/google/callback`
}

function withScheme(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`
}

/**
 * The state cookie: httpOnly so no script can read it, SameSite=Lax so it
 * survives the return trip from Google (a Strict cookie is withheld on a
 * cross-site navigation, which is exactly what the callback is), and short
 * enough that an abandoned sign-in stops being usable on its own.
 */
export function stateCookieHeader(name: string, value: string, secure = process.env.APP_ENV === 'production'): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${STATE_COOKIE_SECONDS}`,
  ]
  if (secure)
    parts.push('Secure')
  return parts.join('; ')
}

/** The session hand-off cookie. A minute is long enough to load one page. */
export function handoffCookieHeader(name: string, token: string, secure = process.env.APP_ENV === 'production'): string {
  const parts = [`${name}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=60']
  if (secure)
    parts.push('Secure')
  return parts.join('; ')
}

/** The same cookie, expired — sent once the state has been spent. */
export function clearCookieHeader(name: string, secure = process.env.APP_ENV === 'production'): string {
  const parts = [`${name}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure)
    parts.push('Secure')
  return parts.join('; ')
}

/** One cookie out of a request's Cookie header, or null. */
export function cookieValue(header: string | null | undefined, name: string): string | null {
  if (!header)
    return null
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key === name)
      return decodeURIComponent(rest.join('=')) || null
  }
  return null
}

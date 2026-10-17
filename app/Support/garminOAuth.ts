import { openOAuthState } from './garminConnect'

export const OAUTH_COOKIE = 'garmin_oauth'
export const NATIVE_GARMIN_STATE_PREFIX = 'native-'

export function readOAuthCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const separator = part.indexOf('=')
    if (separator !== -1 && part.slice(0,separator).trim() === name) return part.slice(separator+1).trim()
  }
  return undefined
}

export function garminSettingsRedirect(outcome: string): Response {
  return new Response(null,{status:302,headers:{Location:`/settings?garmin=${encodeURIComponent(outcome)}`,'Set-Cookie':`${OAUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`}})
}

/** Fixed callback destination; the bearer and PKCE verifier never enter a URL. */
export function nativeGarminRedirect(code: string | null, state: string, error: string | null): Response {
  const query = `state=${encodeURIComponent(state)}&${error ? `error=${encodeURIComponent(error)}` : `code=${encodeURIComponent(code ?? '')}`}`
  return new Response(null,{status:302,headers:{Location:`wildloop://settings?${query}`,'Cache-Control':'no-store'}})
}

/** The authenticated actor must own the signed, unexpired native attempt. */
export function nativeGarminAttempt(handoff: unknown, returnedState: unknown, actor: number, secret: string, now=Date.now()) {
  if (typeof handoff !== 'string' || typeof returnedState !== 'string' || !returnedState.startsWith(NATIVE_GARMIN_STATE_PREFIX)) return null
  const attempt = openOAuthState(handoff,secret,now)
  return attempt?.userId === actor && attempt.state === returnedState ? attempt : null
}

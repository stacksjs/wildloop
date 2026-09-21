import { apiFetch, readyToken } from './auth'

export type ActivityVisibility = 'public' | 'followers' | 'private'

let pending: Promise<ActivityVisibility> | null = null
let pendingForToken: string | null = null

/** Resolve the athlete's server-side default, with the safe default offline. */
export async function loadActivityVisibilityDefault(): Promise<ActivityVisibility> {
  const bearer = await readyToken()

  // Recording and manual-entry controls can be rendered before someone has
  // signed in. The privacy endpoint is deliberately authenticated, so a guest
  // must use the conservative local default instead of creating a guaranteed
  // 401 request (and a browser-console error) merely by opening the page.
  if (!bearer)
    return 'followers'

  if (pending && pendingForToken === bearer)
    return pending

  pendingForToken = bearer
  pending = apiFetch('/api/privacy-settings', {
  })
    .then(async (result) => {
      if (!result.ok) return 'followers' as const
      const payload = await result.json().catch(() => null)
      const value = payload?.settings?.defaultActivityVisibility
      return ['public', 'followers', 'private'].includes(value) ? value : 'followers'
    })
    .catch(() => 'followers')
  return pending
}

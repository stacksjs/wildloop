/**
 * The signed-in athlete as the app is told about them: by /api/me, and by the
 * profile endpoints after they change something, so the client can replace
 * its copy with what the server now holds in one step.
 */

import { profileFields } from './avatars'

/**
 * The user's role names, for the UI to decide what to offer. Never load-
 * bearing: every admin endpoint re-checks the role itself. A failure degrades
 * to "no roles" rather than failing the request.
 */
export async function roleNamesFor(userId: number | null | undefined): Promise<string[]> {
  if (!userId)
    return []
  try {
    // Loose on purpose: the package declares these as `{}`, and the calls
    // are the same ones LoginAction and AdminOverviewAction make.
    const { createBqbRbacStore, Rbac } = await import('@stacksjs/auth') as any
    Rbac.setStore(createBqbRbacStore())
    return ((await Rbac.getUserRoles(userId)) ?? [])
      .map((role: any) => String(role?.name ?? ''))
      .filter(Boolean)
  }
  catch {
    return []
  }
}

export interface SessionUserPayload {
  id: number
  email: string
  name: string
  avatar: string | null
  bio: string | null
  location: string | null
  joinedAt: string | null
  roles: string[]
}

export async function sessionUserPayload(user: Record<string, any>, roles?: string[]): Promise<SessionUserPayload> {
  return {
    id: Number(user.id),
    email: String(user.email ?? ''),
    name: String(user.name ?? ''),
    ...profileFields(user),
    roles: roles ?? await roleNamesFor(Number(user.id)),
  }
}

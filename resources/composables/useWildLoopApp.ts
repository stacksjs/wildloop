import { useStore } from 'stx'
import { currentUser, initializeAuthSession, isSignedIn } from '../assets/scripts/auth'
import { useActivityCatalog } from './useActivityCatalog'
import { useBattleFeed } from './useBattleFeed'
import { useFollows } from './useFollows'
import { useNotifications } from './useNotifications'
import { useRunUploadQueue } from './useRunUploadQueue'
import { useTerritoryCatalog } from './useTerritoryCatalog'
import { useTrailCatalog } from './useTrailCatalog'

interface BootstrapUser {
  id: number
  email: string
  name?: string
  avatar?: string | null
  roles?: string[]
}

type WildLoopAppStore =
  & NonNullable<Parameters<typeof useTrailCatalog>[0]>
  & NonNullable<Parameters<typeof useTerritoryCatalog>[0]>
  & NonNullable<Parameters<typeof useActivityCatalog>[0]>
  & NonNullable<Parameters<typeof useFollows>[0]>
  & NonNullable<Parameters<typeof useNotifications>[0]>
  & NonNullable<Parameters<typeof useRunUploadQueue>[0]>
  & NonNullable<Parameters<typeof useBattleFeed>[0]>
  & {
    hydrateAuthenticatedUser: (user: BootstrapUser) => void
    clearAuthenticatedUser: () => void
  }

function cachedUser(): BootstrapUser | null {
  if (typeof localStorage === 'undefined')
    return null
  const raw = localStorage.getItem('auth_user')
  if (!raw)
    return null
  try {
    return JSON.parse(raw) as BootstrapUser
  }
  catch {
    localStorage.removeItem('auth_user')
    return null
  }
}

async function serverUser(): Promise<BootstrapUser | null> {
  await initializeAuthSession()
  return currentUser()
}

export interface AppDataNeeds {
  activities: boolean
  battles: boolean
  follows: boolean
  territories: boolean
  trails: boolean
}

function isPath(pathname: string, routes: string[]): boolean {
  return routes.some(route => pathname === route || pathname.startsWith(`${route}/`))
}

/** Public data sources needed by a route; everything else stays network-idle. */
export function dataNeedsForPath(pathname: string): AppDataNeeds {
  return {
    activities: isPath(pathname, ['/activity', '/athlete', '/feed', '/profile', '/record', '/stats']),
    battles: isPath(pathname, ['/battles', '/challenges', '/conquests', '/territories', '/territory']),
    follows: isPath(pathname, ['/athlete', '/athletes', '/feed', '/profile']),
    territories: isPath(pathname, ['/battles', '/challenges', '/conquests', '/leaderboard', '/record', '/territories', '/territory']),
    trails: isPath(pathname, ['/record', '/routes', '/trail', '/trails']),
  }
}

let identityStarted = false

/** Initialize the shared WildLoop store and its browser-side data sources. */
export function useWildLoopApp(): void {
  void initializeAuthSession()
  const wl = useStore('wl') as WildLoopAppStore
  const localUser = cachedUser()
  const hasSession = Boolean(localUser) || isSignedIn()
  const pathname = typeof location === 'undefined' ? '/' : location.pathname
  const needs = dataNeedsForPath(pathname)

  if (localUser)
    wl.hydrateAuthenticatedUser(localUser)

  if (needs.trails)
    useTrailCatalog(wl)
  if (needs.territories)
    useTerritoryCatalog(wl)
  if (needs.activities)
    useActivityCatalog(wl)
  if (needs.battles)
    useBattleFeed(wl)
  if (hasSession && needs.follows)
    useFollows(wl)
  if (hasSession) {
    useNotifications(wl)
    useRunUploadQueue(wl)
  }

  // The server remains authoritative. Local identity only prevents a flash
  // of signed-out UI while the current bearer token is checked.
  if (identityStarted)
    return
  identityStarted = true
  serverUser().then((user) => {
    if (user)
      wl.hydrateAuthenticatedUser(user)
    else
      wl.clearAuthenticatedUser()
  })
}
